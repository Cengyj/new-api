package model

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"

	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"gorm.io/gorm"
)

const userCacheSchemaVersion = 2
const walletCacheCoordinationTimeout = 5 * time.Second

var ErrWalletCacheRecoveryRequired = common.NewMessage("Wallet cache recovery is required. Contact the administrator.")
var ErrWalletCacheValidationUnavailable = common.NewMessage("Wallet cache validation is unavailable. Try again later.")

// A restored Redis snapshot can contain an old complete balance without a
// committed credit's marker. Validate its server run inside the same command
// as every read/publication/credit; a separate INFO request would race restart.
// Unknown balances are never overwritten or credited heuristically. INFO must
// be permitted by the Redis ACL. A genuine cache miss keeps SQL hydration.
const walletCacheRunGuard = `
local walletServer = redis.pcall('INFO', 'server')
if type(walletServer) ~= 'string' then
  return redis.error_reply('WALLET_CACHE_VALIDATION_UNAVAILABLE')
end
local walletRunID = string.match(walletServer, 'run_id:([0-9a-f]+)')
if not walletRunID then
  return redis.error_reply('WALLET_CACHE_VALIDATION_UNAVAILABLE')
end
if redis.call('HEXISTS', KEYS[1], 'Quota') == 1
  and redis.call('HGET', KEYS[1], 'WalletRedisRunID') ~= walletRunID then
  return redis.error_reply('WALLET_CACHE_RECOVERY_REQUIRED')
end
`

// Server-side command/ACL failures cannot be treated as a cache miss when the
// required generation check did not run. Transport failures retain the existing
// database fallback contract; they do not assert that an old hash was valid.
func walletCacheValidationError(err error) error {
	if err == nil {
		return nil
	}
	if err.Error() == "WALLET_CACHE_RECOVERY_REQUIRED" || err.Error() == "ERR WALLET_CACHE_RECOVERY_REQUIRED" {
		return ErrWalletCacheRecoveryRequired
	}
	var serverError redis.Error
	if errors.As(err, &serverError) {
		return fmt.Errorf("%w: %v", ErrWalletCacheValidationUnavailable, err)
	}
	return err
}

type UserBase struct {
	Id          int    `json:"id" redis:"Id"`
	Group       string `json:"group" redis:"Group"`
	Email       string `json:"email" redis:"Email"`
	Quota       int    `json:"quota" redis:"Quota"`
	Status      int    `json:"status" redis:"Status"`
	Role        int    `json:"role" redis:"Role"`
	Username    string `json:"username" redis:"Username"`
	Setting     string `json:"setting" redis:"Setting"`
	AuthVersion int64  `json:"-" redis:"AuthVersion"`
	CacheSchema int    `json:"-" redis:"CacheSchema"`
}

func (user *UserBase) WriteContext(c *gin.Context) {
	common.SetContextKey(c, constant.ContextKeyUserGroup, user.Group)
	common.SetContextKey(c, constant.ContextKeyUserQuota, user.Quota)
	common.SetContextKey(c, constant.ContextKeyUserStatus, user.Status)
	common.SetContextKey(c, constant.ContextKeyUserEmail, user.Email)
	common.SetContextKey(c, constant.ContextKeyUserName, user.Username)
	common.SetContextKey(c, constant.ContextKeyUserSetting, user.GetSetting())
}

func (user *UserBase) GetSetting() dto.UserSetting {
	setting := dto.UserSetting{}
	if user.Setting != "" {
		err := common.Unmarshal([]byte(user.Setting), &setting)
		if err != nil {
			common.SysLog(common.LogText("failed to unmarshal setting: %s", err.Error()))
		}
	}
	return setting
}

// getUserCacheKey returns the key for user cache
func getUserCacheKey(userId int) string {
	return fmt.Sprintf("user:%d", userId)
}

func userCacheTTLSeconds() int {
	ttl := common.RedisKeyCacheSeconds()
	if ttl <= 0 {
		return 60
	}
	return ttl
}

// invalidateUserCache clears user cache
func invalidateUserCache(userId int) error {
	if !common.RedisEnabled {
		return nil
	}
	return common.RedisDelKey(getUserCacheKey(userId))
}

func populateUserCache(user User) error {
	if !common.RedisEnabled {
		return nil
	}
	return writeUserCache(user.ToBaseUser(), true)
}

// updateUserCache refreshes non-quota user cache fields.
// Quota is maintained by atomic quota delta paths and must not be overwritten
// by stale user snapshots from profile/settings updates.
func updateUserCache(user User) error {
	if !common.RedisEnabled {
		return nil
	}
	return writeUserCache(user.ToBaseUser(), false)
}

// lockWalletUsersTx serializes wallet credits with cold-cache publication.
// Lock users in ID order, after any order/rule locks. SQLite needs a write
// reservation before the read; SELECT FOR UPDATE is unsupported there.
func lockWalletUsersTx(tx *gorm.DB, userIDs ...int) ([]User, error) {
	if common.UsingMainDatabase(common.DatabaseTypeSQLite) {
		if err := tx.Model(&User{}).Where("id IN ?", userIDs).UpdateColumn("id", gorm.Expr("id")).Error; err != nil {
			return nil, err
		}
	}
	var users []User
	err := lockForUpdate(tx).Omit("password", "access_token").Where("id IN ?", userIDs).Order("id ASC").Find(&users).Error
	return users, err
}

// GetUserCache gets complete user cache from hash. Cache hits retain the
// existing quota path. On a miss, keep the user lock from the authoritative
// read through publication, so a wallet credit cannot miss a pre-commit fill
// or add its delta to a post-commit fill. Do not call from a transaction that
// already holds this user's lock; callers use it outside funds/auth writes.
func GetUserCache(userId int) (*UserBase, error) {
	userCache, err := cacheGetUserBase(userId)
	if err == nil {
		return userCache, nil
	}
	if errors.Is(err, ErrWalletCacheRecoveryRequired) || errors.Is(err, ErrWalletCacheValidationUnavailable) {
		return nil, err
	}
	if !common.RedisEnabled {
		user, err := GetUserById(userId, false)
		if err != nil {
			return nil, err
		}
		return user.ToBaseUser(), nil
	}
	if userId == 0 {
		return nil, common.NewMessage("ID is empty!")
	}
	ctx, cancel := context.WithTimeout(context.Background(), walletCacheCoordinationTimeout)
	defer cancel()
	// Reserve before reading SQL. If the database later drops our lock, a
	// concurrent credit can still cancel this token before the old read publishes.
	// Pin the reservation command so an ambiguous SET cannot be replayed on
	// another socket. Release its connection before waiting for SQL: all code
	// holding both resources acquires the user lock before a Redis connection.
	reservation := common.RDB.Conn(ctx)
	fillToken, fillErr := reserveWalletCacheFill(ctx, reservation, userId)
	_ = reservation.Close()
	var user User
	err = DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		users, err := lockWalletUsersTx(tx, userId)
		if err != nil {
			return err
		}
		if len(users) != 1 {
			return gorm.ErrRecordNotFound
		}
		user = users[0]
		connection := common.RDB.Conn(ctx)
		defer connection.Close()
		// Redis failures retain DB fallback. A newer auth fence is the one
		// exception: never re-authorize a restrictive update still pending.
		floor, floorErr := getUserAuthVersionFloor(ctx, connection, userId)
		if floorErr == nil && floor > user.AuthVersion {
			return ErrUserAuthCachePending
		}
		if fillErr == nil {
			fillErr = publishUserCache(ctx, connection, user.ToBaseUser(), fillToken)
		}
		if fillErr != nil {
			if errors.Is(fillErr, ErrUserAuthCachePending) || errors.Is(fillErr, ErrWalletCacheRecoveryRequired) || errors.Is(fillErr, ErrWalletCacheValidationUnavailable) {
				return fillErr
			}
			common.SysLog(common.LogText("failed to synchronously populate user cache: %s", fillErr.Error()))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return user.ToBaseUser(), nil
}

func cacheGetUserBase(userId int) (*UserBase, error) {
	if !common.RedisEnabled {
		return nil, fmt.Errorf("redis is not enabled")
	}
	var userCache UserBase
	ctx, cancel := context.WithTimeout(context.Background(), walletCacheCoordinationTimeout)
	defer cancel()
	command := redis.NewStringStringMapCmd(ctx, "eval", walletCacheRunGuard+`return redis.call('HGETALL', KEYS[1])`, 1, getUserCacheKey(userId))
	if err := common.RDB.Process(ctx, command); err != nil {
		return nil, walletCacheValidationError(err)
	}
	if len(command.Val()) == 0 {
		return nil, fmt.Errorf("user cache is missing")
	}
	if err := command.Scan(&userCache); err != nil {
		return nil, err
	}
	if userCache.Id != userId || userCache.CacheSchema != userCacheSchemaVersion || userCache.AuthVersion <= 0 {
		return nil, fmt.Errorf("user cache schema is stale")
	}
	floor, err := getUserAuthVersionFloor(context.Background(), common.RDB, userId)
	if err != nil {
		return nil, err
	}
	if floor > userCache.AuthVersion {
		return nil, ErrUserAuthCachePending
	}
	return &userCache, nil
}

// Add atomic quota operations using hash fields.
// 通过守卫式 Lua 脚本执行：哈希不存在时直接跳过（下次读取会从数据库水合），
// 不会像裸 HINCRBY 那样创建只含 Quota 字段的残缺哈希。
func cacheIncrUserQuota(userId int, delta int64) error {
	if !common.RedisEnabled {
		return nil
	}
	_, err := cacheApplyUserQuotaDelta(userId, delta)
	return err
}

func cacheDecrUserQuota(userId int, delta int64) error {
	return cacheIncrUserQuota(userId, -delta)
}

// syncCreditUserQuotaCache 在授信事务（充值/兑换等）提交后同步把增量补进缓存
// 余额。预扣以缓存值为准（存在期间），授信不能绕过它，否则新到账的额度在
// 缓存过期前不可用；缓存未命中无需处理，下次读取会从已提交的数据库余额水合。
func syncCreditUserQuotaCache(userId int, quota int, operation string) {
	if quota <= 0 {
		return
	}
	if err := cacheIncrUserQuota(userId, int64(quota)); err != nil {
		common.SysLog(common.LogText("failed to sync %s credit to user quota cache: %s", operation, err.Error()))
	}
}

func getWalletCacheFillKey(userID int) string {
	return fmt.Sprintf("wallet:user:fill:%d", userID)
}

// Bind each acknowledged reservation to the Redis run observed before the SQL
// read. Restoring a token from an earlier snapshot must not authorize an old
// SQL balance to acquire the new run's identity during delayed publication.
func reserveWalletCacheFill(ctx context.Context, connection redis.Cmdable, userID int) (string, error) {
	const script = walletCacheRunGuard + `
local fillToken = walletRunID .. ':' .. ARGV[1]
redis.call('SET', KEYS[2], fillToken, 'EX', ARGV[2])
return fillToken`
	token, err := connection.Eval(ctx, script, []string{getUserCacheKey(userID), getWalletCacheFillKey(userID)}, common.GetUUID(), userCacheTTLSeconds()).Text()
	return token, walletCacheValidationError(err)
}

// captureWalletCreditCache fences older publications while holding the user
// lock. Each attempt owns its marker, so a known rollback can clean it without
// deleting a newer retry's marker. No uncertain Redis command is retried on a
// different connection before deciding whether SQL may commit.
func captureWalletCreditCache(tx *gorm.DB, userID int, operation string) (string, error) {
	if !common.RedisEnabled {
		return "", nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), walletCacheCoordinationTimeout)
	defer cancel()
	connection := common.RDB.Conn(ctx)
	defer connection.Close()
	attempt := common.GetUUID()
	const observeScript = walletCacheRunGuard + `
return walletRunID .. ':' .. (redis.call('HGET', KEYS[1], 'WalletGeneration') or '')`
	const fenceScript = walletCacheRunGuard + `
if walletRunID .. ':' .. (redis.call('HGET', KEYS[1], 'WalletGeneration') or '') ~= ARGV[4] then
  return 0
end
redis.call('DEL', KEYS[2])
if tonumber(redis.call('HGET', KEYS[1], 'Id') or '0') ~= tonumber(ARGV[1])
  or tonumber(redis.call('HGET', KEYS[1], 'CacheSchema') or '0') ~= tonumber(ARGV[2])
  or redis.call('HEXISTS', KEYS[1], 'Quota') == 0 then
  return 1
end
redis.call('HSET', KEYS[1], 'WalletGeneration', ARGV[3])
return 2`
	const captureScript = walletCacheRunGuard + `
if redis.call('HGET', KEYS[1], 'WalletGeneration') ~= ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[1], ARGV[2], ARGV[1])
return 1`
	for {
		if err := ctx.Err(); err != nil {
			return attempt, err
		}
		observed, err := connection.Eval(ctx, observeScript, []string{getUserCacheKey(userID)}).Text()
		if err != nil {
			return attempt, walletCacheValidationError(err)
		}
		// Observe Redis BEFORE checking the original SQL transaction. If its
		// connection dropped, never let a late command fence a newer credit.
		// If the lock is lost after this read, a competing completion changes
		// the observed generation, and the conditional fence rejects us.
		var current User
		if err := tx.WithContext(ctx).Select("id").Where("id = ?", userID).First(&current).Error; err != nil {
			return attempt, err
		}
		fenced, err := connection.Eval(ctx, fenceScript,
			[]string{getUserCacheKey(userID), getWalletCacheFillKey(userID)}, userID, userCacheSchemaVersion, attempt, observed).Int()
		if err != nil || fenced == 1 {
			return attempt, walletCacheValidationError(err)
		}
		if fenced == 0 {
			continue
		}
		captured, err := connection.Eval(ctx, captureScript, []string{getUserCacheKey(userID)},
			attempt, "WalletCredit:"+operation).Int()
		if err != nil || captured == 1 {
			return attempt, walletCacheValidationError(err)
		}
		// Another already-committed operation may finish between these two
		// commands and rotate the generation. Re-observe and validate the same
		// SQL transaction before attempting another conditional capture.
	}
}

// cancelWalletCreditCache is only for a transaction that never attempted
// commit. A lost commit acknowledgement must instead keep the original
// operation recoverable. Ownership checks protect a concurrently started retry.
func cancelWalletCreditCache(userID int, operation, attempt string) {
	if !common.RedisEnabled || operation == "" || attempt == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), walletCacheCoordinationTimeout)
	defer cancel()
	const script = walletCacheRunGuard + `
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
  redis.call('HDEL', KEYS[1], ARGV[1])
end
if redis.call('HGET', KEYS[1], 'WalletGeneration') == ARGV[2] then
  redis.call('HSET', KEYS[1], 'WalletGeneration', ARGV[3])
end
return 1`
	if err := common.RDB.Eval(ctx, script, []string{getUserCacheKey(userID)}, "WalletCredit:"+operation, attempt, common.GetUUID()).Err(); err != nil {
		common.SysLog(common.LogText("failed to cancel wallet credit cache user_id=%d operation=%s: %s", userID, operation, err.Error()))
	}
}

// Publish the balance, completion marker and generation in one Redis command:
// Lua errors do not roll back earlier commands. Cleanup may fail after that
// publication, but a retry only removes the completed marker, never credits it
// again. Delayed captures cannot recreate a completed marker. Other pending
// operations remain independently recoverable, and successful cleanup keeps
// completed operations from growing a hash kept alive by metadata refreshes.
// Failure does not undo committed SQL. Propagate it so the caller retries the
// same durable identity instead of acknowledging an unfinished cache credit.
func finishWalletCreditCache(userID int, operation string, quota int) error {
	if !common.RedisEnabled || operation == "" || quota <= 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), walletCacheCoordinationTimeout)
	defer cancel()
	const script = walletCacheRunGuard + `
local marker = redis.call('HGET', KEYS[1], ARGV[1])
if not marker then
  return 0
end
if marker ~= 'done' then
  -- HINCRBY validates signed int64 arithmetic; HGET avoids Lua number rounding.
  redis.call('HSET', KEYS[1], 'WalletCreditNextQuota', redis.call('HGET', KEYS[1], 'Quota') or '0')
  redis.call('HINCRBY', KEYS[1], 'WalletCreditNextQuota', ARGV[2])
  local nextQuota = redis.call('HGET', KEYS[1], 'WalletCreditNextQuota')
  redis.call('HSET', KEYS[1], 'Quota', nextQuota, ARGV[1], 'done', 'WalletGeneration', ARGV[3])
end
redis.call('HDEL', KEYS[1], ARGV[1], 'WalletCreditNextQuota')
return 1`
	if err := common.RDB.Eval(ctx, script, []string{getUserCacheKey(userID)}, "WalletCredit:"+operation, quota, common.GetUUID()).Err(); err != nil {
		common.SysLog(common.LogText("failed to finish wallet credit cache user_id=%d operation=%s: %s", userID, operation, err.Error()))
		return walletCacheValidationError(err)
	}
	return nil
}

// Helper functions to get individual fields if needed
func getUserGroupCache(userId int) (string, error) {
	cache, err := GetUserCache(userId)
	if err != nil {
		return "", err
	}
	return cache.Group, nil
}

func getUserQuotaCache(userId int) (int, error) {
	cache, err := GetUserCache(userId)
	if err != nil {
		return 0, err
	}
	return cache.Quota, nil
}

func getUserNameCache(userId int) (string, error) {
	cache, err := GetUserCache(userId)
	if err != nil {
		return "", err
	}
	return cache.Username, nil
}

func getUserSettingCache(userId int) (dto.UserSetting, error) {
	cache, err := GetUserCache(userId)
	if err != nil {
		return dto.UserSetting{}, err
	}
	return cache.GetSetting(), nil
}

// RefreshUserGroupCache writes the database-authoritative group into an
// existing user hash without changing the user's authentication version.
func RefreshUserGroupCache(userId int) error {
	if !common.RedisEnabled {
		return nil
	}
	if userId <= 0 {
		return fmt.Errorf("invalid user id")
	}
	var authoritative User
	if err := DB.Select("id", "auth_version", commonGroupCol).Where("id = ?", userId).First(&authoritative).Error; err != nil {
		return err
	}
	// Group transitions intentionally keep the same authentication version. A
	// refresh that read the previous group can therefore arrive after a newer
	// refresh and still pass the auth-version fence. Re-read after every write
	// and repair the cache when the authoritative group changed in between.
	for range 3 {
		if err := updateUserCacheFieldAtVersion(userId, "Group", authoritative.Group, authoritative.AuthVersion); err != nil {
			return err
		}

		var verified User
		if err := DB.Select("id", "auth_version", commonGroupCol).Where("id = ?", userId).First(&verified).Error; err != nil {
			return err
		}
		if verified.AuthVersion == authoritative.AuthVersion && verified.Group == authoritative.Group {
			return nil
		}
		authoritative = verified
	}

	// Preserve the freshest snapshot observed even when the row was too busy to
	// stabilize within the bounded retries. Returning an error lets best-effort
	// callers emit an operation-specific warning.
	if err := updateUserCacheFieldAtVersion(userId, "Group", authoritative.Group, authoritative.AuthVersion); err != nil {
		return err
	}
	return fmt.Errorf("user group changed repeatedly during cache refresh")
}

func updateUserEmailCache(userId int, email string) error {
	return updateUserCacheField(userId, "Email", email)
}

func updateUserNameCache(userId int, username string) error {
	return updateUserCacheField(userId, "Username", username)
}

func updateUserSettingCache(userId int, setting string) error {
	return updateUserCacheField(userId, "Setting", setting)
}

// updateUserCacheField prevents individual cache refreshes from bypassing the
// auth-version fence. It intentionally does nothing when the complete hash is
// absent; the next GetUserCache call will repopulate it from the database.
func updateUserCacheField(userId int, field string, value any) error {
	if !common.RedisEnabled {
		return nil
	}
	var user User
	if err := DB.Select("id", "auth_version").Where("id = ?", userId).First(&user).Error; err != nil {
		return err
	}
	if user.AuthVersion <= 0 {
		return fmt.Errorf("invalid user auth version")
	}
	return updateUserCacheFieldAtVersion(userId, field, value, user.AuthVersion)
}

// GetUserLanguage returns the user's language preference from cache
// Uses the existing GetUserCache mechanism for efficiency
func GetUserLanguage(userId int) string {
	userCache, err := GetUserCache(userId)
	if err != nil {
		return ""
	}
	return userCache.GetSetting().Language
}
