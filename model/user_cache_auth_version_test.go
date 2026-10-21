package model

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"errors"
	"net"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/alicebob/miniredis/v2"
	miniredisserver "github.com/alicebob/miniredis/v2/server"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// creditCommitPool injects a real post-commit interleaving (and optionally a
// lost commit acknowledgement), rather than simulating a pre-commit failure.
type creditCommitPool struct {
	gorm.ConnPool
	afterCommit func() error
}

func (pool creditCommitPool) BeginTx(ctx context.Context, options *sql.TxOptions) (gorm.ConnPool, error) {
	tx, err := pool.ConnPool.(gorm.TxBeginner).BeginTx(ctx, options)
	if err != nil {
		return nil, err
	}
	return &creditCommitTx{Tx: tx, afterCommit: pool.afterCommit}, nil
}

type creditCommitTx struct {
	*sql.Tx
	afterCommit func() error
}

func (tx creditCommitTx) Commit() error {
	if err := tx.Tx.Commit(); err != nil {
		return err
	}
	return tx.afterCommit()
}

// deferredWalletRedisConn models a sent command whose execution outlives the
// client's timeout. The test later sends the exact captured RESP bytes to the
// real isolated Redis server; no production Lua or response is mocked.
type deferredWalletRedisConn struct {
	net.Conn
	deferCommand func([]byte) bool
	timedOut     bool
}

func (conn *deferredWalletRedisConn) Write(command []byte) (int, error) {
	if conn.deferCommand(command) {
		conn.timedOut = true
		return len(command), nil
	}
	return conn.Conn.Write(command)
}

func (conn *deferredWalletRedisConn) Read(response []byte) (int, error) {
	if conn.timedOut {
		return 0, os.ErrDeadlineExceeded
	}
	return conn.Conn.Read(response)
}

// lostWalletCreditReplyConn executes the real finalization script, then drops
// its reply. The next read obeys the real socket deadline, including when the
// client's configured read timeout is disabled.
type lostWalletCreditReplyConn struct {
	net.Conn
	dropReply bool
	dropped   chan<- string
}

func (conn *lostWalletCreditReplyConn) Write(command []byte) (int, error) {
	if bytes.Contains(command, []byte("local marker = redis.call(")) {
		conn.dropReply = true
	}
	return conn.Conn.Write(command)
}

func (conn *lostWalletCreditReplyConn) Read(response []byte) (int, error) {
	if conn.dropReply {
		conn.dropReply = false
		reply, err := bufio.NewReader(conn.Conn).ReadString('\n')
		if err != nil {
			return 0, err
		}
		conn.dropped <- reply
	}
	return conn.Conn.Read(response)
}

func useUserCacheMiniRedis(t *testing.T) *miniredis.Miniredis {
	t.Helper()
	server := miniredis.RunT(t)
	// miniredis lacks INFO server. Supply server identity only; integration
	// tests exercise the real Lua and restart boundary against isolated Redis.
	server.Server().SetPreHook(func(peer *miniredisserver.Peer, command string, args ...string) bool {
		if command == "INFO" && len(args) == 1 && args[0] == "server" {
			peer.WriteBulk("# Server\r\nrun_id:0123456789abcdef0123456789abcdef01234567\r\n")
			return true
		}
		return false
	})
	oldRedisEnabled := common.RedisEnabled
	oldRDB := common.RDB
	oldSyncFrequency := common.SyncFrequency
	common.RedisEnabled = true
	common.SyncFrequency = 2
	common.RDB = redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() {
		_ = common.RDB.Close()
		common.RedisEnabled = oldRedisEnabled
		common.RDB = oldRDB
		common.SyncFrequency = oldSyncFrequency
	})
	return server
}

func TestUserAuthFenceRollbackExpiresAndRecovers(t *testing.T) {
	truncateTables(t)
	server := useUserCacheMiniRedis(t)

	user := User{
		Username:    "auth-fence-rollback",
		Password:    "password",
		Role:        common.RoleCommonUser,
		Status:      common.UserStatusEnabled,
		Group:       "default",
		AuthVersion: 1,
	}
	require.NoError(t, DB.Create(&user).Error)
	require.NoError(t, populateUserCache(user))

	tx := DB.Begin()
	require.NoError(t, tx.Error)
	next, err := IncrementUserAuthVersionWithTx(tx, user.Id)
	require.NoError(t, err)
	assert.EqualValues(t, 2, next)

	_, err = cacheGetUserBase(user.Id)
	assert.ErrorIs(t, err, ErrUserAuthCachePending)
	cacheTTL, err := common.RDB.TTL(t.Context(), getUserCacheKey(user.Id)).Result()
	require.NoError(t, err)
	fenceTTL, err := common.RDB.TTL(t.Context(), getUserAuthFenceKey(user.Id)).Result()
	require.NoError(t, err)
	assert.Greater(t, fenceTTL, cacheTTL)
	require.NoError(t, tx.Rollback().Error)

	server.FastForward(time.Duration(userAuthFenceTTLSeconds()+1) * time.Second)
	assert.False(t, server.Exists(getUserAuthFenceKey(user.Id)))
	committed, err := common.RDB.Get(t.Context(), getUserAuthVersionKey(user.Id)).Result()
	require.NoError(t, err)
	assert.Equal(t, "1", committed)

	cached, err := GetUserCache(user.Id)
	require.NoError(t, err)
	assert.EqualValues(t, 1, cached.AuthVersion)
}

func TestPendingUserAuthFenceRejectsStaleCacheWrite(t *testing.T) {
	server := useUserCacheMiniRedis(t)
	const userID = 4201
	require.NoError(t, SetUserAuthVersionFence(userID, 2))

	err := writeUserCache(&UserBase{
		Id: userID, Group: "default", Username: "stale", AuthVersion: 1,
	}, true)

	assert.ErrorIs(t, err, ErrUserAuthCachePending)
	assert.False(t, server.Exists(getUserCacheKey(userID)))
}

func TestUserAuthFieldUpdateRejectsVersionMismatch(t *testing.T) {
	useUserCacheMiniRedis(t)
	const userID = 4202
	require.NoError(t, writeUserCache(&UserBase{
		Id: userID, Group: "current", Username: "cached", AuthVersion: 3,
	}, true))

	err := updateUserCacheFieldAtVersion(userID, "Group", "stale", 2)

	assert.ErrorIs(t, err, ErrUserAuthCachePending)
	group, err := common.RDB.HGet(t.Context(), getUserCacheKey(userID), "Group").Result()
	require.NoError(t, err)
	assert.Equal(t, "current", group)
}

func TestRefreshUserGroupCacheRepairsDelayedSameVersionWrite(t *testing.T) {
	truncateTables(t)
	useUserCacheMiniRedis(t)

	user := User{
		Username:    "delayed-group-refresh",
		Password:    "password",
		Role:        common.RoleCommonUser,
		Status:      common.UserStatusEnabled,
		Group:       "default",
		AuthVersion: 1,
	}
	require.NoError(t, DB.Create(&user).Error)
	require.NoError(t, populateUserCache(user))

	firstSnapshotRead := make(chan struct{})
	releaseDelayedRefresh := make(chan struct{})
	var intercepted atomic.Bool
	const callbackName = "test:block_delayed_group_refresh"
	require.NoError(t, DB.Callback().Query().After("gorm:query").Register(callbackName, func(*gorm.DB) {
		if intercepted.CompareAndSwap(false, true) {
			close(firstSnapshotRead)
			<-releaseDelayedRefresh
		}
	}))
	t.Cleanup(func() {
		_ = DB.Callback().Query().Remove(callbackName)
	})

	delayedResult := make(chan error, 1)
	go func() {
		delayedResult <- RefreshUserGroupCache(user.Id)
	}()
	<-firstSnapshotRead

	require.NoError(t, DB.Model(&User{}).Where("id = ?", user.Id).Update("group", "pro").Error)
	require.NoError(t, RefreshUserGroupCache(user.Id))
	cached, err := cacheGetUserBase(user.Id)
	require.NoError(t, err)
	assert.Equal(t, "pro", cached.Group)
	assert.EqualValues(t, 1, cached.AuthVersion)

	close(releaseDelayedRefresh)
	require.NoError(t, <-delayedResult)
	cached, err = cacheGetUserBase(user.Id)
	require.NoError(t, err)
	assert.Equal(t, "pro", cached.Group)
	assert.EqualValues(t, 1, cached.AuthVersion)
}

func TestCommittedUserAuthVersionPermanentlyRejectsDelayedCacheFill(t *testing.T) {
	truncateTables(t)
	server := useUserCacheMiniRedis(t)

	user := User{
		Username:    "auth-fence-commit",
		Password:    "password",
		Role:        common.RoleCommonUser,
		Status:      common.UserStatusEnabled,
		Group:       "default",
		AuthVersion: 1,
	}
	require.NoError(t, DB.Create(&user).Error)
	require.NoError(t, populateUserCache(user))
	stale := *user.ToBaseUser()

	require.NoError(t, DB.Transaction(func(tx *gorm.DB) error {
		_, err := IncrementUserAuthVersionWithTx(tx, user.Id)
		return err
	}))
	require.NoError(t, PublishUserAuthCache(user.Id))
	assert.False(t, server.Exists(getUserAuthFenceKey(user.Id)))
	committed, err := common.RDB.Get(t.Context(), getUserAuthVersionKey(user.Id)).Result()
	require.NoError(t, err)
	assert.Equal(t, "2", committed)

	server.FastForward(time.Duration(userAuthFenceTTLSeconds()+1) * time.Second)
	require.NoError(t, common.RedisDelKey(getUserCacheKey(user.Id)))
	err = writeUserCache(&stale, true)
	assert.True(t, errors.Is(err, ErrUserAuthCachePending))
	committed, err = common.RDB.Get(t.Context(), getUserAuthVersionKey(user.Id)).Result()
	require.NoError(t, err)
	assert.Equal(t, "2", committed)
}

func TestUserAuthVersionFenceAndCommittedFloorAreMonotonic(t *testing.T) {
	truncateTables(t)
	server := useUserCacheMiniRedis(t)

	const userID = 4101
	require.NoError(t, SetUserAuthVersionFence(userID, 5))
	require.NoError(t, SetUserAuthVersionFence(userID, 3))
	pending, err := common.RDB.Get(t.Context(), getUserAuthFenceKey(userID)).Result()
	require.NoError(t, err)
	assert.Equal(t, "5", pending)
	floor, err := getUserAuthVersionFloor(t.Context(), common.RDB, userID)
	require.NoError(t, err)
	assert.EqualValues(t, 5, floor)

	// Committing an older transaction must neither clear a newer pending fence
	// nor lower the effective deny floor.
	require.NoError(t, publishCommittedUserAuthVersion(userID, 3))
	pending, err = common.RDB.Get(t.Context(), getUserAuthFenceKey(userID)).Result()
	require.NoError(t, err)
	assert.Equal(t, "5", pending)
	floor, err = getUserAuthVersionFloor(t.Context(), common.RDB, userID)
	require.NoError(t, err)
	assert.EqualValues(t, 5, floor)

	require.NoError(t, publishCommittedUserAuthVersion(userID, 5))
	assert.False(t, server.Exists(getUserAuthFenceKey(userID)))
	committed, err := common.RDB.Get(t.Context(), getUserAuthVersionKey(userID)).Result()
	require.NoError(t, err)
	assert.Equal(t, "5", committed)

	require.NoError(t, publishCommittedUserAuthVersion(userID, 4))
	committed, err = common.RDB.Get(t.Context(), getUserAuthVersionKey(userID)).Result()
	require.NoError(t, err)
	assert.Equal(t, "5", committed)
}

func TestReferralWalletSettlementWithIsolatedRedis(t *testing.T) {
	address := os.Getenv("NEW_API_REFERRAL_REDIS_ADDR")
	if address == "" {
		t.Skip("set NEW_API_REFERRAL_REDIS_ADDR to a disposable isolated Redis instance")
	}
	inviter, invitee := referralFixture(t, 1000)
	previousClient, previousEnabled := common.RDB, common.RedisEnabled
	client := redis.NewClient(&redis.Options{Addr: address, DB: 15, MaxRetries: -1, PoolSize: 1})
	require.NoError(t, client.Ping(t.Context()).Err())
	info, err := client.Info(t.Context(), "server").Result()
	require.NoError(t, err)
	for line := range strings.SplitSeq(info, "\n") {
		if strings.HasPrefix(line, "redis_version:") {
			t.Log(strings.TrimSpace(line))
		}
	}
	common.RDB, common.RedisEnabled = client, true
	ownedKeys := []string{getUserCacheKey(invitee.Id), getUserAuthFenceKey(invitee.Id), getUserAuthVersionKey(invitee.Id), getWalletCacheFillKey(invitee.Id)}
	t.Cleanup(func() {
		assert.NoError(t, client.Del(context.Background(), ownedKeys...).Err())
		assert.NoError(t, client.Close())
		common.RDB, common.RedisEnabled = previousClient, previousEnabled
	})
	require.NoError(t, populateUserCache(invitee))
	initialFields, err := client.HLen(t.Context(), getUserCacheKey(invitee.Id)).Result()
	require.NoError(t, err)
	credit := 100
	first := TopUp{UserId: invitee.Id, TradeNo: "redis-wallet-success", CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
	require.NoError(t, first.Insert())
	alreadyDone, err := RechargeEpay(first.TradeNo, "", "")
	require.NoError(t, err)
	assert.False(t, alreadyDone)
	cached, err := cacheGetUserBase(invitee.Id)
	require.NoError(t, err)
	assert.Equal(t, 100, cached.Quota)
	alreadyDone, err = RechargeEpay(first.TradeNo, "", "")
	require.NoError(t, err)
	assert.True(t, alreadyDone)
	cached, err = cacheGetUserBase(invitee.Id)
	require.NoError(t, err)
	assert.Equal(t, 100, cached.Quota)
	// Profile/auth metadata refreshes extend the hash TTL. A settled order
	// must not add a permanent history field to that continuously live hash.
	require.NoError(t, updateUserCache(invitee))
	settledFields, err := client.HLen(t.Context(), getUserCacheKey(invitee.Id)).Result()
	require.NoError(t, err)
	assert.Equal(t, initialFields, settledFields, "completed wallet operations must not accumulate in a refreshed cache")

	// A pre-commit coordination error is a technical failure, not confirmation
	// of payment settlement. Roll back all funds and retry the original order
	// after Redis recovers. Only fixture-owned keys are changed.
	require.NoError(t, client.Del(t.Context(), getUserCacheKey(invitee.Id)).Err())
	require.NoError(t, client.Set(t.Context(), getUserCacheKey(invitee.Id), "wrong-type-fixture", time.Minute).Err())
	second := TopUp{UserId: invitee.Id, TradeNo: "redis-wallet-postcommit-error", CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
	require.NoError(t, second.Insert())
	alreadyDone, err = RechargeEpay(second.TradeNo, "", "")
	require.Error(t, err)
	assert.False(t, alreadyDone)
	require.NoError(t, DB.First(&second, second.Id).Error)
	assert.Equal(t, common.TopUpStatusPending, second.Status)
	assert.Zero(t, second.CompleteTime)
	require.NoError(t, DB.First(&invitee, invitee.Id).Error)
	require.NoError(t, DB.First(&inviter, inviter.Id).Error)
	assert.Equal(t, 100, invitee.Quota)
	assert.Equal(t, 10, inviter.AffQuota)
	require.NoError(t, client.Del(t.Context(), getUserCacheKey(invitee.Id)).Err())
	alreadyDone, err = RechargeEpay(second.TradeNo, "", "")
	require.NoError(t, err)
	assert.False(t, alreadyDone)
	alreadyDone, err = RechargeEpay(second.TradeNo, "", "")
	require.NoError(t, err)
	assert.True(t, alreadyDone)
	require.NoError(t, DB.First(&invitee, invitee.Id).Error)
	require.NoError(t, DB.First(&inviter, inviter.Id).Error)
	assert.Equal(t, 200, invitee.Quota)
	assert.Equal(t, 20, inviter.AffQuota)
	assert.Equal(t, 20, inviter.AffHistoryQuota)
	var count int64
	require.NoError(t, DB.Model(&ReferralRebate{}).Where("inviter_id = ?", inviter.Id).Count(&count).Error)
	assert.EqualValues(t, 2, count)
	require.NoError(t, client.Del(t.Context(), getUserCacheKey(invitee.Id)).Err())
	cached, err = GetUserCache(invitee.Id)
	require.NoError(t, err)
	assert.Equal(t, 200, cached.Quota)
	alreadyDone, err = RechargeEpay(second.TradeNo, "", "")
	require.NoError(t, err)
	assert.True(t, alreadyDone)
	cached, err = cacheGetUserBase(invitee.Id)
	require.NoError(t, err)
	assert.Equal(t, 200, cached.Quota)
}

func TestReferralCreditDoesNotDoubleARefilledCache(t *testing.T) {
	address := os.Getenv("NEW_API_REFERRAL_REDIS_ADDR")
	if address == "" {
		t.Skip("set NEW_API_REFERRAL_REDIS_ADDR to a disposable isolated Redis instance")
	}
	for _, operation := range []string{"topup", "transfer"} {
		for _, state := range []string{"cold", "replaced", "warm_batch_consumption", "refill_lost_commit_ack", "warm_lost_commit_ack", "warm_delayed_resolution", "warm_verified_commit_cache_unavailable"} {
			t.Run(operation+"/"+state, func(t *testing.T) {
				_, user := referralFixture(t, 1000)
				resetBatchUpdateTestState(t)
				user.AffQuota = 100
				if state == "warm_batch_consumption" {
					user.Quota = 100
					common.BatchUpdateEnabled = true
				}
				require.NoError(t, DB.Model(&user).Updates(map[string]any{"aff_quota": user.AffQuota, "quota": user.Quota}).Error)
				previousDB, previousClient, previousEnabled, previousUnit := DB, common.RDB, common.RedisEnabled, common.QuotaPerUnit
				client := redis.NewClient(&redis.Options{Addr: address, MaxRetries: -1})
				require.NoError(t, client.Ping(t.Context()).Err())
				unavailable := redis.NewClient(&redis.Options{Addr: address, MaxRetries: -1})
				require.NoError(t, unavailable.Close())
				common.RDB, common.RedisEnabled, common.QuotaPerUnit = client, true, 1
				keys := []string{getUserCacheKey(user.Id), getUserAuthFenceKey(user.Id), getUserAuthVersionKey(user.Id), getWalletCacheFillKey(user.Id)}
				t.Cleanup(func() {
					DB, common.RDB, common.RedisEnabled, common.QuotaPerUnit = previousDB, previousClient, previousEnabled, previousUnit
					assert.NoError(t, client.Del(context.Background(), keys...).Err())
					assert.NoError(t, client.Close())
				})
				if state == "replaced" || strings.HasPrefix(state, "warm_") {
					require.NoError(t, populateUserCache(user))
				}
				credit := 100
				expectedQuota := user.Quota + credit
				order := TopUp{UserId: user.Id, TradeNo: "cache-refill-after-commit", CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
				require.NoError(t, order.Insert())
				DB = previousDB.Session(&gorm.Session{Context: t.Context()})
				commitAckLost := errors.New("injected lost acknowledgement after actual database commit")
				lookupBlocked := false
				require.NoError(t, DB.Callback().Query().Before("gorm:query").Register("credit_result_lookup_failure", func(tx *gorm.DB) {
					if lookupBlocked && (tx.Statement.Table == "top_ups" || tx.Statement.Table == "affiliate_transfers") {
						tx.AddError(errors.New("injected result lookup unavailable"))
					}
				}))
				t.Cleanup(func() { assert.NoError(t, previousDB.Callback().Query().Remove("credit_result_lookup_failure")) })
				var committed atomic.Bool
				DB.Statement.ConnPool = creditCommitPool{ConnPool: previousDB.Statement.ConnPool, afterCommit: func() error {
					if !committed.CompareAndSwap(false, true) {
						return nil // The nested cold-cache read also uses a transaction.
					}
					// This executes after sql.Tx.Commit actually succeeded, before
					// the original funds request sends its cache delta.
					if state == "warm_lost_commit_ack" || state == "warm_delayed_resolution" || state == "warm_verified_commit_cache_unavailable" {
						lookupBlocked = state == "warm_delayed_resolution"
						if state == "warm_verified_commit_cache_unavailable" {
							common.RDB = unavailable
						}
						return commitAckLost
					}
					if state == "warm_batch_consumption" {
						reserved, err := TryReserveUserQuota(user.Id, 30)
						assert.True(t, reserved)
						expectedQuota -= 30
						return err
					}
					if state == "replaced" {
						if err := client.Del(t.Context(), getUserCacheKey(user.Id)).Err(); err != nil {
							return err
						}
					}
					cached, err := GetUserCache(user.Id)
					if err != nil {
						return err
					}
					assert.Equal(t, expectedQuota, cached.Quota)
					if state == "refill_lost_commit_ack" {
						return commitAckLost
					}
					return nil
				}}
				if operation == "topup" {
					_, err := RechargeEpay(order.TradeNo, "", "")
					if state == "warm_delayed_resolution" {
						require.ErrorIs(t, err, commitAckLost)
					} else if state == "warm_verified_commit_cache_unavailable" {
						require.Error(t, err, "confirming SQL commit is not confirmation of cache completion")
					} else {
						require.NoError(t, err)
					}
				} else {
					_, err := user.TransferAffQuotaToQuota(100, "cache-refill-transfer-identity")
					if state == "warm_delayed_resolution" {
						require.ErrorIs(t, err, commitAckLost)
					} else if state == "warm_verified_commit_cache_unavailable" {
						require.Error(t, err, "confirming SQL commit is not confirmation of cache completion")
					} else {
						require.NoError(t, err, "the original durable identity resolves a lost commit acknowledgement")
					}
				}
				lookupBlocked = false
				DB, common.RDB = previousDB, client
				if state == "warm_verified_commit_cache_unavailable" {
					require.NoError(t, DB.First(&user, user.Id).Error)
					assert.Equal(t, expectedQuota, user.Quota)
					cached, err := cacheGetUserBase(user.Id)
					require.NoError(t, err)
					assert.Zero(t, cached.Quota, "the cache still needs same-identity recovery despite the verified SQL result")
				}
				batchUpdate()
				if operation == "topup" {
					duplicate, err := RechargeEpay(order.TradeNo, "", "")
					require.NoError(t, err)
					assert.True(t, duplicate)
				} else {
					known, err := GetAffiliateTransfer(user.Id, "cache-refill-transfer-identity")
					require.NoError(t, err)
					require.NotNil(t, known)
					assert.Equal(t, 100, known.Quota)
					_, err = user.TransferAffQuotaToQuota(100, known.RequestID)
					require.NoError(t, err)
				}
				cached, err := cacheGetUserBase(user.Id)
				require.NoError(t, err)
				assert.Equal(t, expectedQuota, cached.Quota)
				require.NoError(t, DB.First(&user, user.Id).Error)
				assert.Equal(t, expectedQuota, user.Quota)
				reserved, err := TryReserveUserQuota(user.Id, expectedQuota+1)
				require.NoError(t, err)
				assert.False(t, reserved, "the refill race must not create extra spendable quota")
			})
		}
	}
}

func TestReferralWalletRejectsDelayedRedisCommands(t *testing.T) {
	address := os.Getenv("NEW_API_REFERRAL_REDIS_ADDR")
	if address == "" {
		t.Skip("set NEW_API_REFERRAL_REDIS_ADDR to a disposable isolated Redis instance")
	}
	for _, operation := range []string{"topup", "transfer"} {
		for _, stage := range []string{"fill_reservation", "fill_publication", "capture_fence", "capture_same_hash", "capture_replaced_hash", "finish", "finish_unavailable"} {
			t.Run(operation+"/"+stage, func(t *testing.T) {
				inviter, user := referralFixture(t, 1000)
				resetBatchUpdateTestState(t)
				previousClient, previousEnabled, previousUnit := common.RDB, common.RedisEnabled, common.QuotaPerUnit
				client := redis.NewClient(&redis.Options{Addr: address, DB: 14, MaxRetries: -1, PoolSize: 1})
				require.NoError(t, client.Ping(t.Context()).Err())
				common.RDB, common.RedisEnabled, common.QuotaPerUnit = client, true, 1
				common.BatchUpdateEnabled = true
				keys := []string{getUserCacheKey(user.Id), getUserAuthFenceKey(user.Id), getUserAuthVersionKey(user.Id), getWalletCacheFillKey(user.Id)}
				t.Cleanup(func() {
					common.RDB, common.RedisEnabled, common.QuotaPerUnit = previousClient, previousEnabled, previousUnit
					assert.NoError(t, client.Del(context.Background(), keys...).Err())
					assert.NoError(t, client.Close())
				})
				require.NoError(t, DB.Model(&user).Update("aff_quota", 100).Error)
				if !strings.HasPrefix(stage, "fill_") {
					_, err := GetUserCache(user.Id)
					require.NoError(t, err)
				}
				credit := 100
				order := TopUp{UserId: user.Id, TradeNo: "deferred-redis-credit", CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
				require.NoError(t, order.Insert())
				const requestID = "deferred-redis-transfer"
				creditWallet := func() error {
					if operation == "topup" {
						_, err := RechargeEpay(order.TradeNo, "", "")
						return err
					}
					_, err := user.TransferAffQuotaToQuota(credit, requestID)
					return err
				}
				var delayed []byte
				var matched atomic.Int32
				faultClient := redis.NewClient(&redis.Options{
					Addr: address, DB: 14, MaxRetries: 3, PoolSize: 1,
					MinRetryBackoff: time.Millisecond, MaxRetryBackoff: time.Millisecond,
					Dialer: func(ctx context.Context, network, addr string) (net.Conn, error) {
						conn, err := (&net.Dialer{}).DialContext(ctx, network, addr)
						if err != nil {
							return nil, err
						}
						return &deferredWalletRedisConn{Conn: conn, deferCommand: func(command []byte) bool {
							match := false
							switch stage {
							case "fill_reservation":
								match = bytes.Contains(command, []byte("local fillToken = walletRunID"))
							case "fill_publication":
								match = bytes.Contains(command, []byte("local incoming = tonumber(ARGV[1])"))
							case "capture_fence":
								match = bytes.Contains(command, []byte("redis.call('DEL', KEYS[2])"))
							case "capture_same_hash", "capture_replaced_hash":
								match = bytes.Contains(command, []byte("'WalletGeneration') ~= ARGV[1]"))
							case "finish", "finish_unavailable":
								match = bytes.Contains(command, []byte("local marker = redis.call("))
							}
							if !match {
								return false
							}
							hit := matched.Add(1)
							if hit != 1 && stage != "finish_unavailable" {
								return false
							}
							if hit == 1 {
								delayed = bytes.Clone(command)
							}
							return true
						}}, nil
					},
				})
				t.Cleanup(func() { assert.NoError(t, faultClient.Close()) })
				common.RDB = faultClient
				if strings.HasPrefix(stage, "fill_") {
					cached, err := GetUserCache(user.Id)
					require.NoError(t, err, "Redis failure retains the database read fallback")
					assert.Zero(t, cached.Quota)
					require.EqualValues(t, 1, matched.Load(), "a pinned connection must not resend an uncertain reservation/publication")
				} else if strings.HasPrefix(stage, "capture_") {
					require.Error(t, creditWallet(), "an unacknowledged pre-commit cache fence cannot complete the funds transaction")
					require.EqualValues(t, 1, matched.Load(), "a pinned capture must not resend after timeout")
					require.NoError(t, DB.First(&user, user.Id).Error)
					require.NoError(t, DB.First(&inviter, inviter.Id).Error)
					assert.Zero(t, user.Quota)
					assert.Equal(t, 100, user.AffQuota)
					assert.Zero(t, inviter.AffQuota)
					require.NoError(t, DB.First(&order, order.Id).Error)
					assert.Equal(t, common.TopUpStatusPending, order.Status)
					assert.Zero(t, order.CompleteTime)
				} else {
					err := creditWallet()
					if stage == "finish_unavailable" {
						require.Error(t, err, "an unexecuted cache credit must keep the original payment/request retryable")
						require.EqualValues(t, 4, matched.Load(), "all post-commit Redis attempts failed")
						if operation == "transfer" {
							known, lookupErr := GetAffiliateTransfer(user.Id, requestID)
							require.Error(t, lookupErr, "result lookup cannot acknowledge unfinished cache recovery")
							require.NotNil(t, known, "the error does not erase the committed transfer identity")
							assert.Equal(t, requestID, known.RequestID)
							assert.Equal(t, credit, known.Quota)
						}
					} else {
						require.NoError(t, err, "a successful same-operation Redis retry completes recovery")
						require.EqualValues(t, 2, matched.Load(), "the finalization command really retried on another connection")
					}
				}
				require.NotEmpty(t, delayed, "the target production command must have been intercepted")
				common.RDB = client
				if stage == "finish_unavailable" {
					require.NoError(t, DB.First(&user, user.Id).Error)
					assert.Equal(t, credit, user.Quota, "SQL committed before cache completion failed")
					cached, err := GetUserCache(user.Id)
					require.NoError(t, err)
					assert.Zero(t, cached.Quota, "ordinary cache hits do not retry a wallet operation")
					// Metadata refresh can renew this hash indefinitely. It is not a
					// recovery mechanism, so the payment/request must remain retryable.
					require.NoError(t, client.PExpire(t.Context(), keys[0], time.Second).Err())
					require.NoError(t, updateUserCache(user))
					ttl, err := client.PTTL(t.Context(), keys[0]).Result()
					require.NoError(t, err)
					assert.Greater(t, ttl, time.Second)
				}
				if stage == "finish_unavailable" && operation == "transfer" {
					known, err := GetAffiliateTransfer(user.Id, requestID)
					require.NoError(t, err)
					require.NotNil(t, known)
					assert.Equal(t, credit, known.Quota)
					cached, err := cacheGetUserBase(user.Id)
					require.NoError(t, err)
					assert.Equal(t, credit, cached.Quota, "result lookup alone recovers the interrupted cache update")
				}
				if stage == "capture_replaced_hash" {
					require.NoError(t, client.Del(t.Context(), getUserCacheKey(user.Id)).Err())
					_, err := GetUserCache(user.Id)
					require.NoError(t, err)
				}
				require.NoError(t, creditWallet())
				// Keep a real consumption delta unflushed while the old Redis
				// command arrives. No recovery may replace or erase this deduction.
				reserved, err := TryReserveUserQuota(user.Id, 30)
				require.NoError(t, err)
				require.True(t, reserved)
				conn, err := net.DialTimeout("tcp", address, time.Second)
				require.NoError(t, err)
				defer conn.Close()
				require.NoError(t, conn.SetDeadline(time.Now().Add(5*time.Second)))
				reader := bufio.NewReader(conn)
				_, err = conn.Write([]byte("*2\r\n$6\r\nSELECT\r\n$2\r\n14\r\n"))
				require.NoError(t, err)
				response, err := reader.ReadString('\n')
				require.NoError(t, err)
				require.Equal(t, "+OK\r\n", response)
				_, err = conn.Write(delayed)
				require.NoError(t, err)
				response, err = reader.ReadString('\n')
				require.NoError(t, err)
				require.NotEqual(t, byte('-'), response[0], "Redis must execute the delayed real command: %s", response)
				require.NoError(t, creditWallet(), "replay uses the original order/request identity")
				cached, err := GetUserCache(user.Id)
				require.NoError(t, err)
				assert.Equal(t, 70, cached.Quota)
				reserved, err = TryReserveUserQuota(user.Id, 71)
				require.NoError(t, err)
				assert.False(t, reserved, "neither the late command nor replay creates extra spendable quota")
				batchUpdate()
				require.NoError(t, DB.First(&user, user.Id).Error)
				require.NoError(t, DB.First(&inviter, inviter.Id).Error)
				assert.Equal(t, 70, user.Quota)
				var facts, transfers int64
				require.NoError(t, DB.Model(&ReferralRebate{}).Count(&facts).Error)
				require.NoError(t, DB.Model(&AffiliateTransfer{}).Count(&transfers).Error)
				if operation == "topup" {
					var logs int64
					require.NoError(t, DB.Model(&Log{}).Where("user_id = ? AND type = ?", user.Id, LogTypeTopup).Count(&logs).Error)
					assert.EqualValues(t, 1, logs, "confirmed SQL success logs once even when its cache completion is retried")
					assert.EqualValues(t, 1, facts)
					assert.Zero(t, transfers)
					assert.Equal(t, 10, inviter.AffQuota)
					assert.Equal(t, 10, inviter.AffHistoryQuota)
					assert.Equal(t, 100, user.AffQuota)
				} else {
					assert.Zero(t, facts)
					assert.EqualValues(t, 1, transfers)
					assert.Zero(t, user.AffQuota)
					assert.Zero(t, inviter.AffQuota)
				}
			})
		}
	}
}

func TestReferralWalletCompletionBoundsLostRedisReply(t *testing.T) {
	address := os.Getenv("NEW_API_REFERRAL_REDIS_ADDR")
	if address == "" {
		t.Skip("set NEW_API_REFERRAL_REDIS_ADDR to a disposable isolated Redis instance")
	}
	for _, operation := range []string{"topup", "transfer"} {
		t.Run(operation, func(t *testing.T) {
			inviter, user := referralFixture(t, 1000)
			previousClient, previousEnabled, previousUnit := common.RDB, common.RedisEnabled, common.QuotaPerUnit
			client := redis.NewClient(&redis.Options{Addr: address, DB: 11, MaxRetries: -1})
			require.NoError(t, client.Ping(t.Context()).Err())
			keys := []string{getUserCacheKey(user.Id), getUserAuthFenceKey(user.Id), getUserAuthVersionKey(user.Id), getWalletCacheFillKey(user.Id)}
			for _, key := range keys {
				exists, err := client.Exists(t.Context(), key).Result()
				require.NoError(t, err)
				require.Zero(t, exists, "the isolated fixture must not replace an existing key")
			}
			common.RDB, common.RedisEnabled, common.QuotaPerUnit = client, true, 1
			t.Cleanup(func() {
				common.RDB, common.RedisEnabled, common.QuotaPerUnit = previousClient, previousEnabled, previousUnit
				assert.NoError(t, client.Del(context.Background(), keys...).Err())
				assert.NoError(t, client.Close())
			})
			user.AffQuota = 100
			require.NoError(t, DB.Model(&user).Update("aff_quota", user.AffQuota).Error)
			require.NoError(t, populateUserCache(user))
			credit := 100
			order := TopUp{UserId: user.Id, TradeNo: "lost-redis-finish-reply", CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
			if operation == "topup" {
				require.NoError(t, order.Insert())
			}
			const requestID = "lost-redis-finish-reply"
			creditWallet := func() error {
				if operation == "topup" {
					_, err := RechargeEpay(order.TradeNo, "", "")
					return err
				}
				_, err := user.TransferAffQuotaToQuota(credit, requestID)
				return err
			}
			dropped := make(chan string, 1)
			faultClient := redis.NewClient(&redis.Options{
				Addr: address, DB: 11, MaxRetries: -1, ReadTimeout: -1, WriteTimeout: -1, PoolSize: 1,
				Dialer: func(ctx context.Context, network, addr string) (net.Conn, error) {
					conn, err := (&net.Dialer{}).DialContext(ctx, network, addr)
					if err != nil {
						return nil, err
					}
					return &lostWalletCreditReplyConn{Conn: conn, dropped: dropped}, nil
				},
			})
			common.RDB = faultClient
			completed := make(chan error, 1)
			joined := false
			t.Cleanup(func() {
				_ = faultClient.Close()
				if !joined {
					select {
					case <-completed:
					case <-time.After(5 * time.Second):
						t.Error("wallet worker did not exit after closing its isolated Redis connection")
					}
				}
			})
			go func() { completed <- creditWallet() }()
			select {
			case reply := <-dropped:
				require.Equal(t, ":1\r\n", reply, "Redis must finish the real command before its reply is lost")
			case <-time.After(5 * time.Second):
				t.Fatal("wallet operation did not reach post-commit Redis finalization")
			}
			var persisted User
			require.NoError(t, DB.First(&persisted, user.Id).Error)
			assert.Equal(t, credit, persisted.Quota, "SQL was already committed when the reply was lost")
			cachedQuota, err := client.HGet(t.Context(), keys[0], "Quota").Int()
			require.NoError(t, err)
			assert.Equal(t, credit, cachedQuota)
			select {
			case err := <-completed:
				joined = true
				require.Error(t, err, "lost cache confirmation leaves the original identity retryable while SQL stays committed")
			case <-time.After(walletCacheCoordinationTimeout + 2*time.Second):
				t.Error("committed wallet request remains blocked without a bounded cache completion deadline")
				_ = faultClient.Close()
				select {
				case err := <-completed:
					joined = true
					require.Error(t, err)
				case <-time.After(5 * time.Second):
					t.Fatal("wallet worker did not exit")
				}
			}
			common.RDB = client
			require.NoError(t, creditWallet(), "retry keeps the original order or transfer identity")
			if operation == "transfer" {
				result, err := GetAffiliateTransfer(user.Id, requestID)
				require.NoError(t, err)
				require.NotNil(t, result)
				assert.Equal(t, credit, result.Quota)
			}
			require.NoError(t, DB.First(&persisted, user.Id).Error)
			require.NoError(t, DB.First(&inviter, inviter.Id).Error)
			assert.Equal(t, credit, persisted.Quota)
			cachedQuota, err = client.HGet(t.Context(), keys[0], "Quota").Int()
			require.NoError(t, err)
			assert.Equal(t, credit, cachedQuota, "replay cannot double the spendable balance")
			var facts, transfers int64
			require.NoError(t, DB.Model(&ReferralRebate{}).Count(&facts).Error)
			require.NoError(t, DB.Model(&AffiliateTransfer{}).Count(&transfers).Error)
			if operation == "topup" {
				require.NoError(t, DB.First(&order, order.Id).Error)
				assert.Equal(t, common.TopUpStatusSuccess, order.Status)
				assert.EqualValues(t, 1, facts)
				assert.Zero(t, transfers)
				assert.Equal(t, 10, inviter.AffQuota)
				assert.Equal(t, 10, inviter.AffHistoryQuota)
			} else {
				assert.Zero(t, facts)
				assert.EqualValues(t, 1, transfers)
				assert.Zero(t, persisted.AffQuota)
				assert.Zero(t, inviter.AffQuota)
			}
		})
	}
}

func TestReferralWalletRejectsFillAfterSQLLockReleaseAcrossDatabases(t *testing.T) {
	address := os.Getenv("NEW_API_REFERRAL_REDIS_ADDR")
	if address == "" {
		t.Skip("set NEW_API_REFERRAL_REDIS_ADDR to a disposable isolated Redis instance")
	}
	setupAffiliateTransferCompliance(t)
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		for _, operation := range []string{"topup", "transfer"} {
			t.Run(dialect+"/"+operation, func(t *testing.T) {
				db, _ := newReferralIntegrationDatabase(t, dialect)
				previousDB, previousLogDB := DB, LOG_DB
				previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
				previousClient, previousEnabled, previousUnit := common.RDB, common.RedisEnabled, common.QuotaPerUnit
				kind := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
				common.SetDatabaseTypes(kind, kind)
				DB, LOG_DB = db, db
				client := redis.NewClient(&redis.Options{Addr: address, DB: 12, MaxRetries: -1})
				require.NoError(t, client.Ping(t.Context()).Err())
				common.RDB, common.RedisEnabled, common.QuotaPerUnit = client, true, 1
				userID := 100000000 + int(time.Now().UnixNano()%1000000000)
				keys := []string{getUserCacheKey(userID), getUserAuthFenceKey(userID), getUserAuthVersionKey(userID), getWalletCacheFillKey(userID)}
				for _, key := range keys {
					exists, err := client.Exists(t.Context(), key).Result()
					require.NoError(t, err)
					require.Zero(t, exists, "the fixture must not replace another test's key")
				}
				t.Cleanup(func() {
					DB, LOG_DB = previousDB, previousLogDB
					common.SetDatabaseTypes(previousMain, previousLog)
					common.RDB, common.RedisEnabled, common.QuotaPerUnit = previousClient, previousEnabled, previousUnit
					assert.NoError(t, client.Del(context.Background(), keys...).Err())
					assert.NoError(t, client.Close())
				})
				require.NoError(t, db.AutoMigrate(&User{}, &Option{}, &TopUp{}, &SubscriptionOrder{}, &ReferralRebate{}, &AffiliateTransfer{}, &Log{}))
				require.NoError(t, InitializeReferralRebateRule(db))
				require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 1}))
				inviter := User{Id: userID + 1, Username: "lock-release-inviter", AffCode: "lock-release-inviter", Status: common.UserStatusEnabled}
				require.NoError(t, db.Create(&inviter).Error)
				user := User{Id: userID, Username: "lock-release-user", AffCode: "lock-release-user", Status: common.UserStatusEnabled, AffQuota: 100, InviterId: inviter.Id, CreatedAt: time.Now().Unix(), ReferralRateBPS: 1000, ReferralExpiresAt: time.Now().Unix() + 86400}
				require.NoError(t, db.Create(&user).Error)
				credit := 100
				order := TopUp{UserId: user.Id, TradeNo: "lock-release-topup", CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
				if operation == "topup" {
					require.NoError(t, order.Insert())
				}
				var released atomic.Bool
				require.NoError(t, db.Callback().Query().After("gorm:query").Register("test:release_wallet_fill_sql_lock", func(tx *gorm.DB) {
					if tx.Statement.Table == "users" && released.CompareAndSwap(false, true) {
						transaction, ok := tx.Statement.ConnPool.(gorm.TxCommitter)
						require.True(t, ok)
						require.NoError(t, transaction.Rollback(), "release the actual SQL transaction before the Redis publication")
					}
				}))
				t.Cleanup(func() { assert.NoError(t, db.Callback().Query().Remove("test:release_wallet_fill_sql_lock")) })
				var delayed []byte
				faultClient := redis.NewClient(&redis.Options{
					Addr: address, DB: 12, MaxRetries: -1, PoolSize: 1,
					Dialer: func(ctx context.Context, network, addr string) (net.Conn, error) {
						conn, err := (&net.Dialer{}).DialContext(ctx, network, addr)
						if err != nil {
							return nil, err
						}
						return &deferredWalletRedisConn{Conn: conn, deferCommand: func(command []byte) bool {
							if delayed == nil && bytes.Contains(command, []byte("local incoming = tonumber(ARGV[1])")) {
								delayed = bytes.Clone(command)
								return true
							}
							return false
						}}, nil
					},
				})
				t.Cleanup(func() { assert.NoError(t, faultClient.Close()) })
				common.RDB = faultClient
				_, err := GetUserCache(user.Id)
				require.Error(t, err, "the lost SQL transaction is not a successful cache read")
				require.True(t, released.Load())
				require.NotEmpty(t, delayed, "intercept the real publication after its SQL lock was released")
				common.RDB = client
				const requestID = "lock-release-transfer"
				if operation == "topup" {
					_, err = RechargeEpay(order.TradeNo, "", "")
				} else {
					_, err = user.TransferAffQuotaToQuota(credit, requestID)
				}
				require.NoError(t, err, "a separate funds transaction must acquire the released lock and commit")
				conn, err := net.DialTimeout("tcp", address, time.Second)
				require.NoError(t, err)
				defer conn.Close()
				require.NoError(t, conn.SetDeadline(time.Now().Add(5*time.Second)))
				reader := bufio.NewReader(conn)
				_, err = conn.Write([]byte("*2\r\n$6\r\nSELECT\r\n$2\r\n12\r\n"))
				require.NoError(t, err)
				response, err := reader.ReadString('\n')
				require.NoError(t, err)
				require.Equal(t, "+OK\r\n", response)
				for range 2 {
					_, err = conn.Write(delayed)
					require.NoError(t, err)
					response, err = reader.ReadString('\n')
					require.NoError(t, err)
					assert.Equal(t, ":2\r\n", response, "the cancelled reservation rejects stale publication before and after refill")
					cached, err := GetUserCache(user.Id)
					require.NoError(t, err)
					assert.Equal(t, credit, cached.Quota)
				}
				require.NoError(t, db.First(&user, user.Id).Error)
				require.NoError(t, db.First(&inviter, inviter.Id).Error)
				assert.Equal(t, credit, user.Quota)
				var rebates, transfers int64
				require.NoError(t, db.Model(&ReferralRebate{}).Count(&rebates).Error)
				require.NoError(t, db.Model(&AffiliateTransfer{}).Count(&transfers).Error)
				if operation == "topup" {
					require.NoError(t, db.First(&order, order.Id).Error)
					assert.Equal(t, common.TopUpStatusSuccess, order.Status)
					assert.EqualValues(t, 1, rebates)
					assert.Zero(t, transfers)
					assert.Equal(t, 10, inviter.AffQuota)
					assert.Equal(t, 100, user.AffQuota)
				} else {
					assert.Zero(t, rebates)
					assert.EqualValues(t, 1, transfers)
					assert.Zero(t, inviter.AffQuota)
					assert.Zero(t, user.AffQuota)
				}
			})
		}
	}
}

func TestReferralWalletCacheAttemptOwnership(t *testing.T) {
	address := os.Getenv("NEW_API_REFERRAL_REDIS_ADDR")
	if address == "" {
		t.Skip("set NEW_API_REFERRAL_REDIS_ADDR to a disposable isolated Redis instance")
	}
	for _, operation := range []string{"topup", "transfer"} {
		for _, interleaving := range []string{"prior_finish_between_capture_phases", "old_cancel_after_retry_capture"} {
			t.Run(operation+"/"+interleaving, func(t *testing.T) {
				inviter, user := referralFixture(t, 1000)
				resetBatchUpdateTestState(t)
				user.AffQuota = 200
				require.NoError(t, DB.Model(&user).Update("aff_quota", user.AffQuota).Error)
				previousClient, previousEnabled, previousUnit := common.RDB, common.RedisEnabled, common.QuotaPerUnit
				client := redis.NewClient(&redis.Options{Addr: address, DB: 12, MaxRetries: -1})
				require.NoError(t, client.Ping(t.Context()).Err())
				keys := []string{getUserCacheKey(user.Id), getUserAuthFenceKey(user.Id), getUserAuthVersionKey(user.Id), getWalletCacheFillKey(user.Id)}
				for _, key := range keys {
					exists, err := client.Exists(t.Context(), key).Result()
					require.NoError(t, err)
					require.Zero(t, exists, "the isolated fixture must not replace an existing key")
				}
				common.RDB, common.RedisEnabled, common.QuotaPerUnit = client, true, 1
				t.Cleanup(func() {
					common.RDB, common.RedisEnabled, common.QuotaPerUnit = previousClient, previousEnabled, previousUnit
					assert.NoError(t, client.Del(context.Background(), keys...).Err())
					assert.NoError(t, client.Close())
				})
				require.NoError(t, populateUserCache(user))
				initialFields, err := client.HLen(t.Context(), getUserCacheKey(user.Id)).Result()
				require.NoError(t, err)
				credit := 100
				orders := []TopUp{
					{UserId: user.Id, TradeNo: "attempt-ownership-first", CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending},
					{UserId: user.Id, TradeNo: "attempt-ownership-second", CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending},
				}
				requestIDs := []string{"attempt-ownership-first", "attempt-ownership-second"}
				if operation == "topup" {
					for i := range orders {
						require.NoError(t, orders[i].Insert())
					}
				}
				creditWallet := func(index int) error {
					if operation == "topup" {
						_, err := RechargeEpay(orders[index].TradeNo, "", "")
						return err
					}
					_, err := user.TransferAffQuotaToQuota(credit, requestIDs[index])
					return err
				}
				firstMarker := "WalletCredit:affiliate:" + requestIDs[0]
				if operation == "topup" {
					firstMarker = "WalletCredit:topup:" + strconv.Itoa(orders[0].Id)
				}
				var delayed []byte
				// Replay the exact production RESP command, after its original caller
				// timed out. Redis executes the real Lua, with no mocked response.
				replayDelayed := func() error {
					conn, err := net.DialTimeout("tcp", address, time.Second)
					if err != nil {
						return err
					}
					defer conn.Close()
					if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
						return err
					}
					reader := bufio.NewReader(conn)
					for _, command := range [][]byte{[]byte("*2\r\n$6\r\nSELECT\r\n$2\r\n12\r\n"), delayed} {
						if _, err := conn.Write(command); err != nil {
							return err
						}
						response, err := reader.ReadString('\n')
						if err != nil {
							return err
						}
						if response == "" || response[0] == '-' {
							return errors.New("delayed Redis command failed: " + response)
						}
					}
					return nil
				}
				var deferred, replayed atomic.Bool
				var retryPhase atomic.Bool
				var phaseTwoCalls atomic.Int32
				faultClient := redis.NewClient(&redis.Options{
					Addr: address, DB: 12, MaxRetries: -1, PoolSize: 1,
					Dialer: func(ctx context.Context, network, addr string) (net.Conn, error) {
						conn, err := (&net.Dialer{}).DialContext(ctx, network, addr)
						if err != nil {
							return nil, err
						}
						return &deferredWalletRedisConn{Conn: conn, deferCommand: func(command []byte) bool {
							if interleaving == "prior_finish_between_capture_phases" && retryPhase.Load() && bytes.Contains(command, []byte("'WalletGeneration') ~= ARGV[1]")) {
								phaseTwoCalls.Add(1)
								if replayed.CompareAndSwap(false, true) {
									assert.NoError(t, replayDelayed())
								}
							}
							match := interleaving == "prior_finish_between_capture_phases" && bytes.Contains(command, []byte("local marker = redis.call(")) ||
								interleaving == "old_cancel_after_retry_capture" && bytes.Contains(command, []byte("if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then"))
							if match && deferred.CompareAndSwap(false, true) {
								delayed = bytes.Clone(command)
								return true
							}
							return false
						}}, nil
					},
				})
				t.Cleanup(func() { assert.NoError(t, faultClient.Close()) })
				common.RDB = faultClient
				var firstAttempt string
				injected := errors.New("injected failure after wallet SQL write before commit")
				if interleaving == "old_cancel_after_retry_capture" {
					callback := func(tx *gorm.DB) {
						if operation == "topup" && tx.Statement.Table != "top_ups" || operation == "transfer" && tx.Statement.Table != "affiliate_transfers" || tx.Error != nil {
							return
						}
						if !retryPhase.Load() {
							tx.AddError(injected)
							return
						}
						if replayed.CompareAndSwap(false, true) {
							currentAttempt, err := client.HGet(t.Context(), keys[0], firstMarker).Result()
							assert.NoError(t, err)
							assert.NotEmpty(t, currentAttempt)
							assert.NotEqual(t, firstAttempt, currentAttempt, "the retry must own a fresh marker")
							if err := replayDelayed(); err != nil {
								tx.AddError(err)
								return
							}
							remaining, err := client.HGet(t.Context(), keys[0], firstMarker).Result()
							assert.NoError(t, err)
							assert.Equal(t, currentAttempt, remaining, "a delayed rollback must not delete the retry's pending credit")
						}
					}
					if operation == "topup" {
						require.NoError(t, DB.Callback().Update().After("gorm:update").Register("test:wallet_attempt_rollback", callback))
						t.Cleanup(func() { assert.NoError(t, DB.Callback().Update().Remove("test:wallet_attempt_rollback")) })
					} else {
						require.NoError(t, DB.Callback().Create().After("gorm:create").Register("test:wallet_attempt_rollback", callback))
						t.Cleanup(func() { assert.NoError(t, DB.Callback().Create().Remove("test:wallet_attempt_rollback")) })
					}
					require.ErrorIs(t, creditWallet(0), injected)
					var rolledBack User
					require.NoError(t, DB.First(&rolledBack, user.Id).Error)
					assert.Zero(t, rolledBack.Quota)
					assert.Equal(t, 200, rolledBack.AffQuota)
				} else {
					require.Error(t, creditWallet(0), "the first SQL credit is committed but its unfinished cache update requires the same-identity retry")
				}
				require.True(t, deferred.Load())
				require.NotEmpty(t, delayed)
				firstAttempt, err = client.HGet(t.Context(), keys[0], firstMarker).Result()
				require.NoError(t, err)
				require.NotEmpty(t, firstAttempt)
				retryPhase.Store(true)
				index, expectedCredits := 0, 1
				if interleaving == "prior_finish_between_capture_phases" {
					index, expectedCredits = 1, 2
				}
				require.NoError(t, creditWallet(index))
				require.True(t, replayed.Load(), "the old real command must execute inside the intended interleaving")
				if interleaving == "prior_finish_between_capture_phases" {
					assert.EqualValues(t, 2, phaseTwoCalls.Load(), "a changed generation must recapture rather than commit without a marker")
				}
				require.NoError(t, creditWallet(0), "replaying the original durable identity never creates another credit")
				require.NoError(t, creditWallet(index))
				cached, err := cacheGetUserBase(user.Id)
				require.NoError(t, err)
				assert.Equal(t, credit*expectedCredits, cached.Quota)
				require.NoError(t, DB.First(&user, user.Id).Error)
				require.NoError(t, DB.First(&inviter, inviter.Id).Error)
				assert.Equal(t, credit*expectedCredits, user.Quota)
				var rebates, transfers int64
				require.NoError(t, DB.Model(&ReferralRebate{}).Count(&rebates).Error)
				require.NoError(t, DB.Model(&AffiliateTransfer{}).Count(&transfers).Error)
				if operation == "topup" {
					assert.EqualValues(t, expectedCredits, rebates)
					assert.Zero(t, transfers)
					assert.Equal(t, 10*expectedCredits, inviter.AffQuota)
					assert.Equal(t, 10*expectedCredits, inviter.AffHistoryQuota)
					assert.Equal(t, 200, user.AffQuota)
				} else {
					assert.Zero(t, rebates)
					assert.EqualValues(t, expectedCredits, transfers)
					assert.Equal(t, 200-credit*expectedCredits, user.AffQuota)
					assert.Zero(t, inviter.AffQuota)
				}
				fields, err := client.HLen(t.Context(), keys[0]).Result()
				require.NoError(t, err)
				assert.Equal(t, initialFields, fields, "settled and rolled-back attempts must leave no growing marker history")
			})
		}
	}
}

// Exercise real transaction loss before the first cache mutation. A successful
// retry must not let the older caller recreate the completed operation marker.
func TestReferralWalletRejectsCaptureAfterSQLLockReleaseAcrossDatabases(t *testing.T) {
	address := os.Getenv("NEW_API_REFERRAL_REDIS_ADDR")
	if address == "" {
		t.Skip("set NEW_API_REFERRAL_REDIS_ADDR to a disposable isolated Redis instance")
	}
	setupAffiliateTransferCompliance(t)
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		for _, operation := range []string{"topup", "transfer"} {
			t.Run(dialect+"/"+operation, func(t *testing.T) {
				db, _ := newReferralIntegrationDatabase(t, dialect)
				previousDB, previousLogDB := DB, LOG_DB
				previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
				previousClient, previousEnabled, previousUnit := common.RDB, common.RedisEnabled, common.QuotaPerUnit
				kind := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
				common.SetDatabaseTypes(kind, kind)
				DB, LOG_DB = db, db
				client := redis.NewClient(&redis.Options{Addr: address, DB: 12, MaxRetries: -1})
				require.NoError(t, client.Ping(t.Context()).Err())
				common.RDB, common.RedisEnabled, common.QuotaPerUnit = client, true, 1
				userID := 100000000 + int(time.Now().UnixNano()%1000000000)
				keys := []string{getUserCacheKey(userID), getUserAuthFenceKey(userID), getUserAuthVersionKey(userID), getWalletCacheFillKey(userID)}
				for _, key := range keys {
					n, err := client.Exists(t.Context(), key).Result()
					require.NoError(t, err)
					require.Zero(t, n)
				}
				t.Cleanup(func() {
					DB, LOG_DB = previousDB, previousLogDB
					common.SetDatabaseTypes(previousMain, previousLog)
					common.RDB, common.RedisEnabled, common.QuotaPerUnit = previousClient, previousEnabled, previousUnit
					assert.NoError(t, client.Del(context.Background(), keys...).Err())
					assert.NoError(t, client.Close())
				})
				require.NoError(t, db.AutoMigrate(&User{}, &Option{}, &TopUp{}, &SubscriptionOrder{}, &ReferralRebate{}, &AffiliateTransfer{}, &Log{}))
				require.NoError(t, InitializeReferralRebateRule(db))
				require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 1}))
				inviter := User{Id: userID + 1, Username: "lost-capture-inviter", AffCode: "lost-capture-inviter", Status: common.UserStatusEnabled}
				require.NoError(t, db.Create(&inviter).Error)
				user := User{Id: userID, Username: "lost-capture-user", AffCode: "lost-capture-user", Status: common.UserStatusEnabled, AffQuota: 100, InviterId: inviter.Id, CreatedAt: time.Now().Unix(), ReferralRateBPS: 1000, ReferralExpiresAt: time.Now().Unix() + 86400}
				require.NoError(t, db.Create(&user).Error)
				_, err := GetUserCache(user.Id)
				require.NoError(t, err)
				credit := 100
				order := TopUp{UserId: user.Id, TradeNo: "lost-capture-order", CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
				if operation == "topup" {
					require.NoError(t, order.Insert())
				}
				const requestID = "lost-capture-transfer"
				creditWallet := func() error {
					if operation == "topup" {
						_, err := RechargeEpay(order.TradeNo, "", "")
						return err
					}
					_, err := user.TransferAffQuotaToQuota(credit, requestID)
					return err
				}
				phase := 0
				var originalTx gorm.TxCommitter
				require.NoError(t, db.Callback().Query().After("gorm:query").Register("test:lost_capture_tx", func(tx *gorm.DB) {
					if phase == 0 && tx.Statement.Table == "users" {
						if transaction, ok := tx.Statement.ConnPool.(gorm.TxCommitter); ok {
							originalTx = transaction
						}
					}
				}))
				require.NoError(t, db.Callback().Update().Before("gorm:update").Register("test:lost_capture_replay", func(tx *gorm.DB) {
					if phase != 2 || tx.Statement.Table != "users" {
						return
					}
					phase = 3
					previous := common.RDB
					common.RDB = client
					err := creditWallet()
					common.RDB = previous
					require.NoError(t, err)
				}))
				t.Cleanup(func() {
					assert.NoError(t, db.Callback().Query().Remove("test:lost_capture_tx"))
					assert.NoError(t, db.Callback().Update().Remove("test:lost_capture_replay"))
				})
				faulty := redis.NewClient(&redis.Options{Addr: address, DB: 12, MaxRetries: -1, PoolSize: 1, Dialer: func(ctx context.Context, network, addr string) (net.Conn, error) {
					conn, err := (&net.Dialer{}).DialContext(ctx, network, addr)
					if err != nil {
						return nil, err
					}
					return &deferredWalletRedisConn{Conn: conn, deferCommand: func(command []byte) bool {
						if phase != 0 || !bytes.Contains(command, []byte("redis.call('DEL', KEYS[2])")) {
							return false
						}
						phase = 1
						require.NotNil(t, originalTx)
						require.NoError(t, originalTx.Rollback())
						previous := common.RDB
						common.RDB = client
						retryErr := creditWallet()
						common.RDB = previous
						require.NoError(t, retryErr, "independent retry commits after the first transaction loses its locks")
						phase = 2
						return false
					}}, nil
				}})
				t.Cleanup(func() { assert.NoError(t, faulty.Close()) })
				common.RDB = faulty
				err = creditWallet()
				if operation == "topup" {
					require.Error(t, err)
				} else {
					require.NoError(t, err, "transfer resolves the same durable request completed by the independent retry")
				}
				common.RDB = client
				require.GreaterOrEqual(t, phase, 2)
				require.NoError(t, creditWallet())
				require.NoError(t, db.First(&user, user.Id).Error)
				require.NoError(t, db.First(&inviter, inviter.Id).Error)
				cached, err := GetUserCache(user.Id)
				require.NoError(t, err)
				assert.Equal(t, credit, user.Quota)
				assert.Equal(t, credit, cached.Quota)
				var rebates, transfers int64
				require.NoError(t, db.Model(&ReferralRebate{}).Count(&rebates).Error)
				require.NoError(t, db.Model(&AffiliateTransfer{}).Count(&transfers).Error)
				if operation == "topup" {
					require.NoError(t, db.First(&order, order.Id).Error)
					assert.Equal(t, common.TopUpStatusSuccess, order.Status)
					assert.EqualValues(t, 1, rebates)
					assert.Zero(t, transfers)
					assert.Equal(t, 10, inviter.AffQuota)
					assert.Equal(t, 100, user.AffQuota)
				} else {
					assert.Zero(t, rebates)
					assert.EqualValues(t, 1, transfers)
					assert.Zero(t, inviter.AffQuota)
					assert.Zero(t, user.AffQuota)
				}
			})
		}
	}
}

func TestReferralWalletCacheRejectsUnknownRedisRun(t *testing.T) {
	address := os.Getenv("NEW_API_REFERRAL_REDIS_ADDR")
	if address == "" {
		t.Skip("set NEW_API_REFERRAL_REDIS_ADDR to a disposable isolated Redis instance")
	}
	for _, state := range []string{"missing_run", "restored_run", "restored_fill", "info_denied"} {
		t.Run(state, func(t *testing.T) {
			inviter, user := referralFixture(t, 1000)
			previousClient, previousEnabled, previousUnit := common.RDB, common.RedisEnabled, common.QuotaPerUnit
			client := redis.NewClient(&redis.Options{Addr: address, DB: 12, MaxRetries: -1})
			require.NoError(t, client.Ping(t.Context()).Err())
			common.RDB, common.RedisEnabled, common.QuotaPerUnit = client, true, 1
			keys := []string{getUserCacheKey(user.Id), getUserAuthFenceKey(user.Id), getUserAuthVersionKey(user.Id), getWalletCacheFillKey(user.Id)}
			for _, key := range keys {
				n, err := client.Exists(t.Context(), key).Result()
				require.NoError(t, err)
				require.Zero(t, n)
			}
			t.Cleanup(func() {
				common.RDB, common.RedisEnabled, common.QuotaPerUnit = previousClient, previousEnabled, previousUnit
				assert.NoError(t, client.Del(context.Background(), keys...).Err())
				assert.NoError(t, client.Close())
			})
			credit := 100
			order := TopUp{UserId: user.Id, TradeNo: "run-guard-order", CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
			require.NoError(t, order.Insert())
			if state == "restored_fill" {
				token, err := reserveWalletCacheFill(t.Context(), client, user.Id)
				require.NoError(t, err)
				_, suffix, ok := strings.Cut(token, ":")
				require.True(t, ok)
				oldToken := strings.Repeat("0", 40) + ":" + suffix
				require.NoError(t, client.Set(t.Context(), getWalletCacheFillKey(user.Id), oldToken, time.Minute).Err())
				require.ErrorIs(t, publishUserCache(t.Context(), client, user.ToBaseUser(), oldToken), ErrWalletCacheRecoveryRequired)
				require.Zero(t, client.Exists(t.Context(), getUserCacheKey(user.Id)).Val())
				_, err = GetUserCache(user.Id)
				require.NoError(t, err, "a new reservation and fresh SQL read recover a genuine miss")
			} else {
				_, err := GetUserCache(user.Id)
				require.NoError(t, err)
				if state == "info_denied" {
					username := "wallet_guard_" + common.GetUUID()
					password := common.GetUUID()
					require.NoError(t, client.Do(t.Context(), "ACL", "SETUSER", username, "on", ">"+password, "~*", "+@all", "-info").Err())
					restricted := redis.NewClient(&redis.Options{Addr: address, Username: username, Password: password, DB: 12, MaxRetries: -1})
					t.Cleanup(func() {
						assert.NoError(t, restricted.Close())
						assert.NoError(t, client.Do(context.Background(), "ACL", "DELUSER", username).Err())
					})
					common.RDB = restricted
					_, err = GetUserCache(user.Id)
					require.ErrorIs(t, err, ErrWalletCacheValidationUnavailable)
					_, err = RechargeEpay(order.TradeNo, "", "")
					require.ErrorIs(t, err, ErrWalletCacheValidationUnavailable)
					common.RDB = client
				} else {
					if state == "missing_run" {
						require.NoError(t, client.HDel(t.Context(), keys[0], "WalletRedisRunID").Err())
					} else {
						require.NoError(t, client.HSet(t.Context(), keys[0], "WalletRedisRunID", strings.Repeat("0", 40)).Err())
					}
					require.NoError(t, client.PExpire(t.Context(), keys[0], 10*time.Second).Err())
					before, err := client.HGetAll(t.Context(), keys[0]).Result()
					require.NoError(t, err)
					_, err = GetUserCache(user.Id)
					require.ErrorIs(t, err, ErrWalletCacheRecoveryRequired)
					require.ErrorIs(t, updateUserCache(user), ErrWalletCacheRecoveryRequired)
					require.ErrorIs(t, finishWalletCreditCache(user.Id, "topup:"+strconv.Itoa(order.Id), credit), ErrWalletCacheRecoveryRequired)
					_, err = RechargeEpay(order.TradeNo, "", "")
					require.ErrorIs(t, err, ErrWalletCacheRecoveryRequired)
					after, err := client.HGetAll(t.Context(), keys[0]).Result()
					require.NoError(t, err)
					assert.Equal(t, before, after)
					ttl, err := client.PTTL(t.Context(), keys[0]).Result()
					require.NoError(t, err)
					assert.LessOrEqual(t, ttl, 10*time.Second, "rejection must not keep stale quota alive")
					require.NoError(t, client.Del(t.Context(), keys[0]).Err(), "only this isolated no-consumption fixture explicitly discards its owned stale hash")
				}
			}
			require.NoError(t, DB.First(&user, user.Id).Error)
			require.NoError(t, DB.First(&inviter, inviter.Id).Error)
			assert.Zero(t, user.Quota)
			assert.Zero(t, inviter.AffQuota)
			_, err := RechargeEpay(order.TradeNo, "", "")
			require.NoError(t, err)
			_, err = RechargeEpay(order.TradeNo, "", "")
			require.NoError(t, err)
			cached, err := GetUserCache(user.Id)
			require.NoError(t, err)
			assert.Equal(t, credit, cached.Quota)
			require.NoError(t, DB.First(&user, user.Id).Error)
			require.NoError(t, DB.First(&inviter, inviter.Id).Error)
			assert.Equal(t, credit, user.Quota)
			assert.Equal(t, 10, inviter.AffQuota)
			var rebates int64
			require.NoError(t, DB.Model(&ReferralRebate{}).Count(&rebates).Error)
			assert.EqualValues(t, 1, rebates)
		})
	}
}

func TestReferralWalletCacheFinalizationCommandFailuresAcrossDatabases(t *testing.T) {
	address := os.Getenv("NEW_API_REFERRAL_REDIS_ADDR")
	if address == "" {
		t.Skip("set NEW_API_REFERRAL_REDIS_ADDR to a disposable isolated Redis instance")
	}
	setupAffiliateTransferCompliance(t)
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		for _, operation := range []string{"topup", "transfer"} {
			for _, denied := range []string{"hdel", "hset", "hincrby"} {
				t.Run(dialect+"/"+operation+"/"+denied, func(t *testing.T) {
					db, _ := newReferralIntegrationDatabase(t, dialect)
					previousDB, previousLogDB := DB, LOG_DB
					previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
					previousClient, previousEnabled, previousUnit := common.RDB, common.RedisEnabled, common.QuotaPerUnit
					kind := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
					common.SetDatabaseTypes(kind, kind)
					DB, LOG_DB = db, db
					client := redis.NewClient(&redis.Options{Addr: address, DB: 12, MaxRetries: -1})
					require.NoError(t, client.Ping(t.Context()).Err())
					common.RDB, common.RedisEnabled, common.QuotaPerUnit = client, true, 1
					userID := 100000000 + int(time.Now().UnixNano()%1000000000)
					keys := []string{getUserCacheKey(userID), getUserAuthFenceKey(userID), getUserAuthVersionKey(userID), getWalletCacheFillKey(userID)}
					for _, key := range keys {
						exists, err := client.Exists(t.Context(), key).Result()
						require.NoError(t, err)
						require.Zero(t, exists, "the fixture must not replace another test's key")
					}
					t.Cleanup(func() {
						DB, LOG_DB = previousDB, previousLogDB
						common.SetDatabaseTypes(previousMain, previousLog)
						common.RDB, common.RedisEnabled, common.QuotaPerUnit = previousClient, previousEnabled, previousUnit
						assert.NoError(t, client.Del(context.Background(), keys...).Err())
						assert.NoError(t, client.Close())
					})
					require.NoError(t, db.AutoMigrate(&User{}, &Option{}, &TopUp{}, &SubscriptionOrder{}, &ReferralRebate{}, &AffiliateTransfer{}, &Log{}))
					require.NoError(t, InitializeReferralRebateRule(db))
					require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 1}))
					inviter := User{Id: userID + 1, Username: "finish-acl-inviter", AffCode: "finish-acl-inviter", Status: common.UserStatusEnabled}
					require.NoError(t, db.Create(&inviter).Error)
					user := User{Id: userID, Username: "finish-acl-user", AffCode: "finish-acl-user", Status: common.UserStatusEnabled, AffQuota: 100, InviterId: inviter.Id, CreatedAt: time.Now().Unix(), ReferralRateBPS: 1000, ReferralExpiresAt: time.Now().Unix() + 86400}
					require.NoError(t, db.Create(&user).Error)
					require.NoError(t, populateUserCache(user))
					credit := 100
					order := TopUp{UserId: user.Id, TradeNo: "finish-acl-topup", CreditedQuota: &credit, PaymentProvider: PaymentProviderEpay, Status: common.TopUpStatusPending}
					const requestID = "finish-acl-transfer-identity"
					marker := "WalletCredit:affiliate:" + requestID
					if operation == "topup" {
						require.NoError(t, order.Insert())
						marker = "WalletCredit:topup:" + strconv.Itoa(order.Id)
					}
					username, password := "wallet_finish_"+common.GetUUID(), common.GetUUID()
					acl := []any{"ACL", "SETUSER", username, "on", ">" + password, "+@all", "-" + denied}
					for _, key := range keys {
						acl = append(acl, "~"+key)
					}
					require.NoError(t, client.Do(t.Context(), acl...).Err())
					restricted := redis.NewClient(&redis.Options{Addr: address, DB: 12, Username: username, Password: password, MaxRetries: -1})
					t.Cleanup(func() {
						assert.NoError(t, restricted.Close())
						assert.NoError(t, client.Do(context.Background(), "ACL", "DELUSER", username).Err())
					})
					var capturedGeneration string
					connection, err := db.DB()
					require.NoError(t, err)
					DB = db.Session(&gorm.Session{Context: t.Context()})
					DB.Statement.ConnPool = creditCommitPool{ConnPool: connection, afterCommit: func() error {
						var err error
						capturedGeneration, err = client.HGet(t.Context(), keys[0], "WalletGeneration").Result()
						common.RDB = restricted
						return err
					}}
					creditWallet := func() error {
						if operation == "topup" {
							_, err := RechargeEpay(order.TradeNo, "", "")
							return err
						}
						_, err := user.TransferAffQuotaToQuota(credit, requestID)
						return err
					}
					require.ErrorIs(t, creditWallet(), ErrWalletCacheValidationUnavailable)
					require.NotEmpty(t, capturedGeneration, "the ACL failure must follow the actual SQL commit")
					DB = db
					require.ErrorIs(t, creditWallet(), ErrWalletCacheValidationUnavailable, "retry the same committed operation while the command remains denied")
					beforeRecovery, err := client.HGetAll(t.Context(), keys[0]).Result()
					require.NoError(t, err)
					if denied == "hdel" {
						assert.Equal(t, "100", beforeRecovery["Quota"], "cleanup failure must not credit a successful operation twice")
						assert.Equal(t, "done", beforeRecovery[marker])
						assert.NotEqual(t, capturedGeneration, beforeRecovery["WalletGeneration"], "a completed credit must fence delayed captures before cleanup")
						// Once committed in Redis, recovery needs only cleanup. Denying
						// both balance-write commands must not strand or repeat it.
						require.NoError(t, client.Do(t.Context(), "ACL", "SETUSER", username, "+hdel", "-hset", "-hincrby").Err())
					} else {
						assert.Equal(t, "0", beforeRecovery["Quota"], "failed preparation must not publish a partial credit")
						assert.Equal(t, capturedGeneration, beforeRecovery[marker])
						assert.Equal(t, capturedGeneration, beforeRecovery["WalletGeneration"])
						require.NoError(t, client.Do(t.Context(), "ACL", "SETUSER", username, "+"+denied).Err())
					}
					require.NoError(t, creditWallet())
					require.NoError(t, creditWallet(), "a completed identity remains idempotent after recovery")
					afterRecovery, err := client.HGetAll(t.Context(), keys[0]).Result()
					require.NoError(t, err)
					assert.Equal(t, "100", afterRecovery["Quota"])
					assert.NotContains(t, afterRecovery, marker)
					assert.NotContains(t, afterRecovery, "WalletCreditNextQuota")
					require.NoError(t, db.First(&user, user.Id).Error)
					require.NoError(t, db.First(&inviter, inviter.Id).Error)
					assert.Equal(t, credit, user.Quota)
					var rebates, transfers int64
					require.NoError(t, db.Model(&ReferralRebate{}).Count(&rebates).Error)
					require.NoError(t, db.Model(&AffiliateTransfer{}).Count(&transfers).Error)
					if operation == "topup" {
						require.NoError(t, db.First(&order, order.Id).Error)
						assert.Equal(t, common.TopUpStatusSuccess, order.Status)
						assert.EqualValues(t, 1, rebates)
						assert.Zero(t, transfers)
						assert.Equal(t, 10, inviter.AffQuota)
						assert.Equal(t, 10, inviter.AffHistoryQuota)
						assert.Equal(t, credit, user.AffQuota)
					} else {
						assert.Zero(t, rebates)
						assert.EqualValues(t, 1, transfers)
						assert.Zero(t, inviter.AffQuota)
						assert.Zero(t, user.AffQuota)
					}
				})
			}
		}
	}
}

func TestReferralWalletCacheFinalizationPreservesSignedIntegerQuota(t *testing.T) {
	address := os.Getenv("NEW_API_REFERRAL_REDIS_ADDR")
	if address == "" {
		t.Skip("set NEW_API_REFERRAL_REDIS_ADDR to a disposable isolated Redis instance")
	}
	previousClient, previousEnabled := common.RDB, common.RedisEnabled
	client := redis.NewClient(&redis.Options{Addr: address, DB: 12, MaxRetries: -1})
	require.NoError(t, client.Ping(t.Context()).Err())
	common.RDB, common.RedisEnabled = client, true
	t.Cleanup(func() {
		common.RDB, common.RedisEnabled = previousClient, previousEnabled
		assert.NoError(t, client.Close())
	})
	for _, tc := range []struct {
		name, before, after string
		credit              int
		fails               bool
	}{
		{name: "negative_wallet", before: "-200", after: "-100", credit: 100},
		{name: "minimum_signed_integer", before: "-9223372036854775808", after: "-9223372036854775807", credit: 1},
		{name: "wallet_limit", before: strconv.Itoa(common.MaxWalletQuota - 1), after: strconv.Itoa(common.MaxWalletQuota), credit: 1},
		{name: "above_float_precision", before: "9007199254740992", after: "9007199254740993", credit: 1},
		{name: "maximum_signed_integer", before: "9223372036854775806", after: "9223372036854775807", credit: 1},
		{name: "signed_integer_overflow", before: "9223372036854775807", after: "9223372036854775807", credit: 1, fails: true},
		{name: "invalid_integer", before: "invalid", after: "invalid", credit: 1, fails: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			userID := 100000000 + int(time.Now().UnixNano()%1000000000)
			key := getUserCacheKey(userID)
			keys := []string{key, getUserAuthFenceKey(userID), getUserAuthVersionKey(userID), getWalletCacheFillKey(userID)}
			for _, ownedKey := range keys {
				exists, err := client.Exists(t.Context(), ownedKey).Result()
				require.NoError(t, err)
				require.Zero(t, exists)
			}
			t.Cleanup(func() { assert.NoError(t, client.Del(context.Background(), keys...).Err()) })
			require.NoError(t, writeUserCache(&UserBase{Id: userID, AuthVersion: 1}, true))
			generation := common.GetUUID()
			const operation = "integer-credit"
			const marker = "WalletCredit:" + operation
			require.NoError(t, client.HSet(t.Context(), key, "Quota", tc.before, "WalletGeneration", generation, marker, generation).Err())
			err := finishWalletCreditCache(userID, operation, tc.credit)
			if tc.fails {
				require.ErrorIs(t, err, ErrWalletCacheValidationUnavailable)
			} else {
				require.NoError(t, err)
				require.NoError(t, finishWalletCreditCache(userID, operation, tc.credit))
			}
			actual, err := client.HGetAll(t.Context(), key).Result()
			require.NoError(t, err)
			assert.Equal(t, tc.after, actual["Quota"])
			if tc.fails {
				assert.Equal(t, generation, actual[marker])
				assert.Equal(t, generation, actual["WalletGeneration"])
			} else {
				assert.NotContains(t, actual, marker)
				assert.NotContains(t, actual, "WalletCreditNextQuota")
				assert.NotEqual(t, generation, actual["WalletGeneration"])
			}
		})
	}
}
