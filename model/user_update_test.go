package model

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupUserUpdateTestState(t *testing.T) {
	t.Helper()
	truncateTables(t)
	require.NoError(t, DB.Exec("DELETE FROM users").Error)

	oldRedisEnabled := common.RedisEnabled
	oldBatchUpdateEnabled := common.BatchUpdateEnabled
	common.RedisEnabled = false
	common.BatchUpdateEnabled = false
	t.Cleanup(func() {
		common.RedisEnabled = oldRedisEnabled
		common.BatchUpdateEnabled = oldBatchUpdateEnabled
	})
}

func createUserBindTestUser(t *testing.T) User {
	t.Helper()
	user := User{
		Username:    "bind-test-user",
		Password:    "unused-password-hash",
		Role:        common.RoleCommonUser,
		Status:      common.UserStatusEnabled,
		Group:       "default",
		AuthVersion: 1,
		AffCode:     "bind-test-aff-code",
	}
	require.NoError(t, DB.Create(&user).Error)
	return user
}

func TestUserUpdateDoesNotOverwriteConcurrentAccountingOrTokenChanges(t *testing.T) {
	setupUserUpdateTestState(t)

	user := User{
		Id:              1,
		Username:        "quota-race-user",
		Password:        "password",
		DisplayName:     "before",
		Status:          common.UserStatusEnabled,
		Quota:           1000,
		UsedQuota:       20,
		RequestCount:    3,
		AffCount:        2,
		AffQuota:        800,
		AffHistoryQuota: 1200,
	}
	user.SetAccessToken("old-token")
	require.NoError(t, DB.Create(&user).Error)

	staleUser, err := GetUserById(user.Id, true)
	require.NoError(t, err)

	require.NoError(t, DB.Model(&User{}).Where("id = ?", user.Id).Updates(map[string]any{
		"quota":         gorm.Expr("quota - ?", 400),
		"used_quota":    gorm.Expr("used_quota + ?", 400),
		"request_count": gorm.Expr("request_count + ?", 1),
		"aff_count":     gorm.Expr("aff_count + ?", 1),
		"aff_quota":     gorm.Expr("aff_quota - ?", 500),
		"aff_history":   gorm.Expr("aff_history + ?", 500),
		"access_token":  "rotated-token",
	}).Error)

	staleUser.DisplayName = "after"
	require.NoError(t, staleUser.Update(false))

	var got User
	require.NoError(t, DB.First(&got, user.Id).Error)
	assert.Equal(t, "after", got.DisplayName)
	assert.Equal(t, 600, got.Quota)
	assert.Equal(t, 420, got.UsedQuota)
	assert.Equal(t, 4, got.RequestCount)
	assert.Equal(t, 3, got.AffCount)
	assert.Equal(t, 300, got.AffQuota)
	assert.Equal(t, 1700, got.AffHistoryQuota)
	assert.Equal(t, "rotated-token", got.GetAccessToken())
}

func TestUsageAccountingSupportsSignedDirectAndBatchDeltas(t *testing.T) {
	setupUserUpdateTestState(t)
	resetBatchUpdateTestState(t)

	user := User{
		Id:           10,
		Username:     "usage-adjustment-user",
		Password:     "password",
		Status:       common.UserStatusEnabled,
		UsedQuota:    1000,
		RequestCount: 3,
	}
	channel := Channel{
		Id:        10,
		Name:      "usage-adjustment-channel",
		Key:       "sk-test",
		Status:    common.ChannelStatusEnabled,
		UsedQuota: 1000,
	}
	require.NoError(t, DB.Create(&user).Error)
	require.NoError(t, DB.Create(&channel).Error)

	UpdateUserUsedQuota(user.Id, -200)
	UpdateUserUsedQuota(user.Id, 50)
	UpdateChannelUsedQuota(channel.Id, -200)
	UpdateChannelUsedQuota(channel.Id, 50)

	var got User
	require.NoError(t, DB.Select("used_quota", "request_count").First(&got, user.Id).Error)
	assert.Equal(t, 850, got.UsedQuota)
	assert.Equal(t, 3, got.RequestCount)
	var gotChannel Channel
	require.NoError(t, DB.Select("used_quota").First(&gotChannel, channel.Id).Error)
	assert.Equal(t, int64(850), gotChannel.UsedQuota)

	common.BatchUpdateEnabled = true
	UpdateUserUsedQuota(user.Id, 400)
	UpdateUserUsedQuota(user.Id, -100)
	UpdateChannelUsedQuota(channel.Id, 400)
	UpdateChannelUsedQuota(channel.Id, -100)

	require.NoError(t, DB.Select("used_quota", "request_count").First(&got, user.Id).Error)
	assert.Equal(t, 850, got.UsedQuota, "batch deltas must remain queued until flush")
	assert.Equal(t, 3, got.RequestCount)
	require.NoError(t, DB.Select("used_quota").First(&gotChannel, channel.Id).Error)
	assert.Equal(t, int64(850), gotChannel.UsedQuota, "batch deltas must remain queued until flush")

	batchUpdate()
	require.NoError(t, DB.Select("used_quota", "request_count").First(&got, user.Id).Error)
	assert.Equal(t, 1150, got.UsedQuota)
	assert.Equal(t, 3, got.RequestCount)
	require.NoError(t, DB.Select("used_quota").First(&gotChannel, channel.Id).Error)
	assert.Equal(t, int64(1150), gotChannel.UsedQuota)
}

func TestRevokeUserAccessTokenOnlyClearsLegacyToken(t *testing.T) {
	setupUserUpdateTestState(t)

	createdAt := int64(100)
	user := User{
		Id:                   2,
		Username:             "token-revoke-user",
		Password:             "password",
		DisplayName:          "before",
		Status:               common.UserStatusEnabled,
		Quota:                1000,
		AffQuota:             800,
		AffHistoryQuota:      1200,
		AccessTokenCreatedAt: &createdAt,
	}
	user.SetAccessToken("legacy-token")
	require.NoError(t, DB.Create(&user).Error)

	require.NoError(t, DB.Model(&User{}).Where("id = ?", user.Id).Updates(map[string]any{
		"quota":        gorm.Expr("quota + ?", 500),
		"aff_quota":    gorm.Expr("aff_quota - ?", 500),
		"display_name": "concurrent-update",
	}).Error)

	tokenRef, err := RevokeUserAccessToken(user.Id)
	require.NoError(t, err)
	assert.Equal(t, AccessTokenFingerprint("legacy-token"), tokenRef)

	var got User
	require.NoError(t, DB.First(&got, user.Id).Error)
	assert.Empty(t, got.GetAccessToken())
	assert.Nil(t, got.AccessTokenCreatedAt)
	assert.Equal(t, "concurrent-update", got.DisplayName)
	assert.Equal(t, 1500, got.Quota)
	assert.Equal(t, 300, got.AffQuota)
	assert.Equal(t, 1200, got.AffHistoryQuota)
}

func TestRevokeUserAccessTokenRejectsSoftDeletedUser(t *testing.T) {
	setupUserUpdateTestState(t)

	user := User{
		Id:       3,
		Username: "deleted-token-revoke-user",
		Password: "password",
		Status:   common.UserStatusEnabled,
	}
	user.SetAccessToken("old-token")
	require.NoError(t, DB.Create(&user).Error)
	require.NoError(t, DB.Delete(&user).Error)

	_, err := RevokeUserAccessToken(user.Id)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound)

	var got User
	require.NoError(t, DB.Unscoped().First(&got, user.Id).Error)
	assert.Equal(t, "old-token", got.GetAccessToken())
}

func TestUpdateUserSettingOnlyUpdatesSetting(t *testing.T) {
	setupUserUpdateTestState(t)

	user := User{
		Id:           2,
		Username:     "setting-user",
		Password:     "password",
		Status:       common.UserStatusEnabled,
		Quota:        1000,
		UsedQuota:    20,
		RequestCount: 3,
	}
	require.NoError(t, DB.Create(&user).Error)

	require.NoError(t, DB.Model(&User{}).Where("id = ?", user.Id).Updates(map[string]any{
		"quota":         gorm.Expr("quota - ?", 250),
		"used_quota":    gorm.Expr("used_quota + ?", 250),
		"request_count": gorm.Expr("request_count + ?", 1),
	}).Error)

	require.NoError(t, UpdateUserSetting(user.Id, dto.UserSetting{Language: "zh"}))

	var got User
	require.NoError(t, DB.First(&got, user.Id).Error)
	assert.Equal(t, 750, got.Quota)
	assert.Equal(t, 270, got.UsedQuota)
	assert.Equal(t, 4, got.RequestCount)
	assert.Equal(t, "zh", got.GetSetting().Language)
}

func TestEnsureEmailAvailableRejectsExistingEmailCaseInsensitive(t *testing.T) {
	setupUserUpdateTestState(t)

	require.NoError(t, DB.Create(&User{
		Username: "existing",
		Password: "old-password",
		Email:    "Taken@Example.com",
		Status:   common.UserStatusEnabled,
	}).Error)

	err := EnsureEmailAvailable(" taken@example.COM ", 0)
	require.ErrorIs(t, err, ErrEmailAlreadyTaken)

	user, err := GetUniqueUserByEmail("TAKEN@example.com")
	require.NoError(t, err)
	assert.Equal(t, "existing", user.Username)

	require.NoError(t, EnsureEmailAvailable("taken@example.com", user.Id))
}

func TestInsertRejectsDuplicateEmailWithoutUniqueIndex(t *testing.T) {
	setupUserUpdateTestState(t)

	require.NoError(t, DB.Create(&User{
		Username: "existing",
		Password: "old-password",
		Email:    "taken@example.com",
		Status:   common.UserStatusEnabled,
	}).Error)

	user := &User{
		Username: "oauth-user",
		Email:    "TAKEN@example.com",
		Role:     common.RoleCommonUser,
		Status:   common.UserStatusEnabled,
	}

	err := user.Insert(0)
	require.ErrorIs(t, err, ErrEmailAlreadyTaken)

	var count int64
	require.NoError(t, DB.Model(&User{}).Where("username = ?", "oauth-user").Count(&count).Error)
	assert.Zero(t, count)
}

func TestInsertKeepsBlankPasswordForPasswordlessUser(t *testing.T) {
	setupUserUpdateTestState(t)

	user := &User{
		Username: "passwordless-user",
		Role:     common.RoleCommonUser,
		Status:   common.UserStatusEnabled,
	}

	require.NoError(t, user.Insert(0))

	var stored User
	require.NoError(t, DB.Where("username = ?", user.Username).First(&stored).Error)
	assert.Empty(t, stored.Password)
}

func TestUpdateUserBindColumnOnlyTouchesTheBindingColumn(t *testing.T) {
	truncateTables(t)

	user := createUserBindTestUser(t)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", user.Id).Updates(map[string]any{
		"role":   common.RoleAdminUser,
		"status": common.UserStatusEnabled,
		"group":  "vip",
	}).Error)

	require.NoError(t, UpdateUserBindColumn(user.Id, "github_id", "gh-12345"))

	reloaded, err := GetUserById(user.Id, true)
	require.NoError(t, err)
	assert.Equal(t, "gh-12345", reloaded.GitHubId)
	assert.Equal(t, common.RoleAdminUser, reloaded.Role)
	assert.Equal(t, common.UserStatusEnabled, reloaded.Status)
	assert.Equal(t, "vip", reloaded.Group)
}

func TestUpdateUserBindColumnPreservesRestrictiveChange(t *testing.T) {
	truncateTables(t)

	user := createUserBindTestUser(t)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", user.Id).
		Update("status", common.UserStatusDisabled).Error)
	require.NoError(t, UpdateUserBindColumn(user.Id, "wechat_id", "wx-open-id"))

	reloaded, err := GetUserById(user.Id, true)
	require.NoError(t, err)
	assert.Equal(t, "wx-open-id", reloaded.WeChatId)
	assert.Equal(t, common.UserStatusDisabled, reloaded.Status)
}

func TestUpdateUserBindColumnRejectsNonWhitelistedColumns(t *testing.T) {
	truncateTables(t)

	user := createUserBindTestUser(t)
	for _, column := range []string{"role", "status", "group", "quota", "username", "password", "id"} {
		assert.Error(t, UpdateUserBindColumn(user.Id, column, "1"), "column %s must be rejected", column)
	}
	assert.Error(t, UpdateUserBindColumn(user.Id, "github_id; DROP TABLE users", "x"))
	assert.Error(t, UpdateUserBindColumn(0, "github_id", "x"))
}

func TestValidateAndFillRejectsPasswordlessUser(t *testing.T) {
	setupUserUpdateTestState(t)

	require.NoError(t, DB.Create(&User{
		Username: "passwordless-user",
		Password: "",
		Status:   common.UserStatusEnabled,
	}).Error)

	loginUser := User{
		Username: "passwordless-user",
		Password: "NewPassword123",
	}
	err := loginUser.ValidateAndFill()
	require.ErrorIs(t, err, ErrInvalidCredentials)

	var stored User
	require.NoError(t, DB.Where("username = ?", "passwordless-user").First(&stored).Error)
	assert.Empty(t, stored.Password)
}

func TestResetUserPasswordByEmailRequiresSingleActiveMatch(t *testing.T) {
	setupUserUpdateTestState(t)

	require.NoError(t, DB.Create(&User{
		Username: "duplicate-1",
		Password: "old-1",
		Email:    "legacy@example.com",
		AffCode:  "dupe1",
		Status:   common.UserStatusEnabled,
	}).Error)
	require.NoError(t, DB.Create(&User{
		Username: "duplicate-2",
		Password: "old-2",
		Email:    "LEGACY@example.com",
		AffCode:  "dupe2",
		Status:   common.UserStatusEnabled,
	}).Error)

	err := ResetUserPasswordByEmail("legacy@example.com", "NewPassword123")
	require.ErrorIs(t, err, ErrEmailAmbiguous)

	var duplicates []User
	require.NoError(t, DB.Where("LOWER(email) = ?", "legacy@example.com").Order("username asc").Find(&duplicates).Error)
	require.Len(t, duplicates, 2)
	assert.Equal(t, "old-1", duplicates[0].Password)
	assert.Equal(t, "old-2", duplicates[1].Password)

	require.NoError(t, DB.Create(&User{
		Username: "unique",
		Password: "old",
		Email:    "unique@example.com",
		AffCode:  "unique",
		Status:   common.UserStatusEnabled,
	}).Error)

	require.NoError(t, ResetUserPasswordByEmail("UNIQUE@example.com", "NewPassword123"))

	var unique User
	require.NoError(t, DB.Where("username = ?", "unique").First(&unique).Error)
	assert.True(t, common.ValidatePasswordAndHash("NewPassword123", unique.Password))

	err = ResetUserPasswordByEmail("missing@example.com", "NewPassword123")
	require.True(t, errors.Is(err, ErrEmailNotFound))
}

func createAccessTokenTestUser(t *testing.T, username string) User {
	t.Helper()
	user := User{
		Username:    username,
		Password:    "unused-password-hash",
		Role:        common.RoleCommonUser,
		Status:      common.UserStatusEnabled,
		Group:       "default",
		AuthVersion: 1,
		AffCode:     username + "-aff",
	}
	require.NoError(t, DB.Create(&user).Error)
	return user
}

func createTestUserAccessToken(t *testing.T, userID int, raw string, expiresAt int64) UserAccessToken {
	t.Helper()
	token := UserAccessToken{Name: raw, TokenHash: AccessTokenFingerprint(raw), TokenHint: AccessTokenHint(raw), ExpiresAt: expiresAt}
	require.NoError(t, token.SetScopes([]string{"profile:read"}))
	require.NoError(t, CreateUserAccessToken(userID, &token, 20))
	return token
}

func TestLegacyAccessTokenRetireAtIsWrittenOnceAndReadOnly(t *testing.T) {
	require.NoError(t, DB.AutoMigrate(&Option{}))
	previous := legacyAccessTokenRetireAt.Load()
	originalMap := common.OptionMap
	common.OptionMap = map[string]string{}
	require.NoError(t, DB.Where(&Option{Key: legacyAccessTokenRetireAtKey}).Delete(&Option{}).Error)
	t.Cleanup(func() {
		legacyAccessTokenRetireAt.Store(previous)
		common.OptionMap = originalMap
		DB.Where(&Option{Key: legacyAccessTokenRetireAtKey}).Delete(&Option{})
	})

	const firstStart = int64(1_800_000_000)
	want := firstStart + 30*24*60*60
	require.NoError(t, EnsureLegacyAccessTokenRetireAt(firstStart))
	assert.Equal(t, want, LegacyAccessTokenRetireAt())

	require.NoError(t, EnsureLegacyAccessTokenRetireAt(firstStart+24*60*60))
	assert.Equal(t, want, LegacyAccessTokenRetireAt())
	var stored Option
	require.NoError(t, DB.Where(&Option{Key: legacyAccessTokenRetireAtKey}).First(&stored).Error)
	assert.Equal(t, strconv.FormatInt(want, 10), stored.Value)

	require.ErrorIs(t, UpdateOption(legacyAccessTokenRetireAtKey, "1"), errLegacyRetireAtReadOnly)
	require.ErrorIs(t, UpdateOptionsBulk(map[string]string{legacyAccessTokenRetireAtKey: "1"}), errLegacyRetireAtReadOnly)
	require.NoError(t, DB.Where(&Option{Key: legacyAccessTokenRetireAtKey}).First(&stored).Error)
	assert.Equal(t, strconv.FormatInt(want, 10), stored.Value)

	require.NoError(t, updateOptionMap(legacyAccessTokenRetireAtKey, stored.Value))
	assert.NotContains(t, common.OptionMap, legacyAccessTokenRetireAtKey)
}

func TestValidateAccessTokenStopsAtLegacyDeadline(t *testing.T) {
	setupUserUpdateTestState(t)
	previous := legacyAccessTokenRetireAt.Load()
	t.Cleanup(func() { legacyAccessTokenRetireAt.Store(previous) })

	user := createAccessTokenTestUser(t, "legacy-deadline-user")
	require.NoError(t, DB.Model(&User{}).Where("id = ?", user.Id).Update("access_token", "legacy-deadline-token").Error)

	legacyAccessTokenRetireAt.Store(time.Now().Add(time.Hour).Unix())
	found, err := ValidateAccessToken("legacy-deadline-token")
	require.NoError(t, err)
	require.NotNil(t, found)
	assert.Equal(t, user.Id, found.Id)

	var userQueries int
	const callbackName = "test:count_legacy_token_queries"
	require.NoError(t, DB.Callback().Query().Before("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table == "users" {
			userQueries++
		}
	}))
	t.Cleanup(func() { _ = DB.Callback().Query().Remove(callbackName) })

	for _, retireAt := range []int64{time.Now().Add(-time.Second).Unix(), 0} {
		legacyAccessTokenRetireAt.Store(retireAt)
		found, err = ValidateAccessToken("legacy-deadline-token")
		require.ErrorIs(t, err, ErrLegacyAccessTokenRetired)
		assert.Nil(t, found)
	}
	assert.Zero(t, userQueries)
}

func TestUserAccessTokenLimitAndOwnership(t *testing.T) {
	setupUserUpdateTestState(t)
	owner := createAccessTokenTestUser(t, "token-owner")
	other := createAccessTokenTestUser(t, "token-other")

	var first UserAccessToken
	for i := range 20 {
		token := createTestUserAccessToken(t, owner.Id, "nap_limit_"+strconv.Itoa(i), 0)
		if i == 0 {
			first = token
		}
	}
	extra := UserAccessToken{TokenHash: AccessTokenFingerprint("nap_limit_extra")}
	require.ErrorIs(t, CreateUserAccessToken(owner.Id, &extra, 20), ErrAccessTokenLimit)
	var count int64
	require.NoError(t, DB.Model(&UserAccessToken{}).Where("user_id = ?", owner.Id).Count(&count).Error)
	assert.EqualValues(t, 20, count)

	_, err := UpdateUserAccessToken(other.Id, first.Id, "stolen", []string{"profile:read"})
	require.ErrorIs(t, err, ErrAccessTokenNotFound)
	_, err = DeleteUserAccessToken(other.Id, first.Id)
	require.ErrorIs(t, err, ErrAccessTokenNotFound)
	stored, err := GetUserAccessToken(owner.Id, first.Id)
	require.NoError(t, err)
	assert.Equal(t, first.Name, stored.Name)

	assert.Equal(t, first.Scopes, stored.Scopes)

	renamed, err := UpdateUserAccessToken(owner.Id, first.Id, "renamed", nil)
	require.NoError(t, err)
	assert.Equal(t, "renamed", renamed.Name)
	assert.Equal(t, first.Scopes, renamed.Scopes, "a rename keeps the grant")
	regranted, err := UpdateUserAccessToken(owner.Id, first.Id, "regranted", []string{"usage:read"})
	require.NoError(t, err)
	assert.Equal(t, "regranted", regranted.Name)
	assert.Equal(t, []string{"usage:read"}, regranted.GetScopes())
	deleted, err := DeleteUserAccessToken(owner.Id, first.Id)
	require.NoError(t, err)
	assert.Equal(t, first.TokenHash, deleted.TokenHash)
	found, err := FindUserAccessTokenByHash(first.TokenHash)
	require.NoError(t, err)
	assert.Nil(t, found)
}

func TestDisablingUserKeepsAccessTokensAndDeletingRemovesThem(t *testing.T) {
	setupUserUpdateTestState(t)
	user := createAccessTokenTestUser(t, "token-lifecycle-user")
	createTestUserAccessToken(t, user.Id, "nap_lifecycle_one", 0)
	createTestUserAccessToken(t, user.Id, "nap_lifecycle_two", time.Now().Add(time.Hour).Unix())
	countTokens := func() int64 {
		var count int64
		require.NoError(t, DB.Model(&UserAccessToken{}).Where("user_id = ?", user.Id).Count(&count).Error)
		return count
	}

	user.Status = common.UserStatusDisabled
	require.NoError(t, user.Update(false))
	assert.EqualValues(t, 2, countTokens())

	revoked, err := user.Delete()
	require.NoError(t, err)
	assert.EqualValues(t, 2, revoked)
	assert.Zero(t, countTokens())

	hardDeleted := createAccessTokenTestUser(t, "token-hard-delete-user")
	createTestUserAccessToken(t, hardDeleted.Id, "nap_hard_delete", 0)
	revoked, err = hardDeleted.HardDelete()
	require.NoError(t, err)
	assert.EqualValues(t, 1, revoked)
	var remaining int64
	require.NoError(t, DB.Model(&UserAccessToken{}).Where("user_id = ?", hardDeleted.Id).Count(&remaining).Error)
	assert.Zero(t, remaining)
}

func TestValidateAuthSessionWithTxChecksAccessTokenIdentity(t *testing.T) {
	setupUserUpdateTestState(t)
	now := time.Now()

	tests := []struct {
		name    string
		prepare func(user *User, token *UserAccessToken, identity *AuthSessionIdentity)
		wantErr bool
	}{
		{name: "active token", prepare: func(*User, *UserAccessToken, *AuthSessionIdentity) {}},
		{name: "expired token", wantErr: true, prepare: func(_ *User, token *UserAccessToken, _ *AuthSessionIdentity) {
			require.NoError(t, DB.Model(token).Update("expires_at", now.Add(-time.Second).Unix()).Error)
		}},
		{name: "deleted token", wantErr: true, prepare: func(user *User, token *UserAccessToken, _ *AuthSessionIdentity) {
			_, err := DeleteUserAccessToken(user.Id, token.Id)
			require.NoError(t, err)
		}},
		{name: "another user's token", wantErr: true, prepare: func(_ *User, _ *UserAccessToken, identity *AuthSessionIdentity) {
			other := createAccessTokenTestUser(t, "token-identity-other")
			identity.UserID = other.Id
		}},
		{name: "stale auth version", wantErr: true, prepare: func(user *User, _ *UserAccessToken, _ *AuthSessionIdentity) {
			require.NoError(t, DB.Model(user).Update("auth_version", 2).Error)
		}},
		{name: "disabled user", wantErr: true, prepare: func(user *User, _ *UserAccessToken, _ *AuthSessionIdentity) {
			require.NoError(t, DB.Model(user).Update("status", common.UserStatusDisabled).Error)
		}},
		{name: "unexpected session version", wantErr: true, prepare: func(_ *User, _ *UserAccessToken, identity *AuthSessionIdentity) {
			identity.SessionVersion = 2
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.NoError(t, DB.Exec("DELETE FROM user_access_tokens").Error)
			require.NoError(t, DB.Exec("DELETE FROM users").Error)
			user := createAccessTokenTestUser(t, "token-identity-user")
			token := createTestUserAccessToken(t, user.Id, "nap_identity_token", now.Add(time.Hour).Unix())
			identity := AuthSessionIdentity{
				UserID: user.Id, SessionID: AccessTokenSessionID(token.Id),
				UserAuthVersion: 1, SessionVersion: AccessTokenSessionVersion,
			}
			tt.prepare(&user, &token, &identity)

			txErr := DB.Transaction(func(tx *gorm.DB) error { return ValidateAuthSessionWithTx(tx, identity) })
			plainErr := ValidateAccessTokenIdentity(identity)
			if !tt.wantErr {
				assert.NoError(t, txErr)
				assert.NoError(t, plainErr)
				return
			}
			assert.ErrorIs(t, txErr, ErrUserSessionInactive)
			assert.ErrorIs(t, plainErr, ErrUserSessionInactive)
		})
	}
}

func TestInvitationRegistrationRewardsAndSnapshotShareCreationTransaction(t *testing.T) {
	setupUserUpdateTestState(t)
	previousPayment := *operation_setting.GetPaymentSetting()
	previousNew, previousInvitee, previousInviter := common.QuotaForNewUser, common.QuotaForInvitee, common.QuotaForInviter
	payment := operation_setting.GetPaymentSetting()
	payment.ComplianceConfirmed = true
	payment.ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
	common.QuotaForNewUser, common.QuotaForInvitee, common.QuotaForInviter = 20, 30, 40
	t.Cleanup(func() {
		*payment = previousPayment
		common.QuotaForNewUser, common.QuotaForInvitee, common.QuotaForInviter = previousNew, previousInvitee, previousInviter
	})
	require.NoError(t, DB.AutoMigrate(&Option{}))
	require.NoError(t, InitializeReferralRebateRule(DB))
	require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: true, RateBPS: 1250, ValidDays: 3}))
	inviter := User{Username: "registration-owner", AffCode: "registration-code", Status: common.UserStatusEnabled, AffQuota: 100, AffHistoryQuota: 200}
	require.NoError(t, DB.Create(&inviter).Error)

	rollback := errors.New("third-party identity association failed")
	failed := User{Username: "registration-rollback", RegistrationAffCode: inviter.AffCode}
	err := DB.Transaction(func(tx *gorm.DB) error {
		if err := failed.InsertWithTx(tx, 0); err != nil {
			return err
		}
		return rollback
	})
	require.ErrorIs(t, err, rollback)
	var count int64
	require.NoError(t, DB.Model(&User{}).Where("username = ?", failed.Username).Count(&count).Error)
	assert.Zero(t, count)
	var owner User
	require.NoError(t, DB.First(&owner, inviter.Id).Error)
	assert.Equal(t, 100, owner.AffQuota)
	assert.Equal(t, 200, owner.AffHistoryQuota)
	assert.Zero(t, owner.AffCount)

	created := User{Username: "registration-success", RegistrationAffCode: inviter.AffCode, CreatedAt: 1, ReferralRateBPS: 9999, ReferralExpiresAt: 2}
	require.NoError(t, created.Insert(0))
	assert.Equal(t, inviter.Id, created.InviterId)
	assert.Equal(t, 50, created.Quota)
	assert.Equal(t, 1250, created.ReferralRateBPS)
	assert.InDelta(t, time.Now().Unix(), created.CreatedAt, 3)
	assert.Equal(t, created.CreatedAt+3*86400, created.ReferralExpiresAt)
	created.FinalizeOAuthUserCreation(inviter.Id)
	created.FinishInsert(inviter.Id)
	require.NoError(t, DB.First(&owner, inviter.Id).Error)
	assert.Equal(t, 140, owner.AffQuota)
	assert.Equal(t, 240, owner.AffHistoryQuota)
	assert.Equal(t, 1, owner.AffCount)
	var stored User
	require.NoError(t, DB.First(&stored, created.Id).Error)
	assert.Equal(t, 50, stored.Quota, "post-commit initialization cannot award again")

	require.NoError(t, SaveReferralRebateRule(ReferralRebateRule{Enabled: false, RateBPS: 1250, ValidDays: 3}))
	paused := User{Username: "registration-paused", RegistrationAffCode: inviter.AffCode}
	require.NoError(t, paused.Insert(0))
	assert.Equal(t, inviter.Id, paused.InviterId)
	assert.Equal(t, 50, paused.Quota, "fixed registration gifts do not depend on the rebate switch")
	assert.Zero(t, paused.ReferralRateBPS)
	assert.Zero(t, paused.ReferralExpiresAt)
	require.NoError(t, DB.First(&owner, inviter.Id).Error)
	assert.Equal(t, 180, owner.AffQuota)
	assert.Equal(t, 280, owner.AffHistoryQuota)

	stored.InviterId, stored.CreatedAt, stored.ReferralRateBPS, stored.ReferralExpiresAt = 9999, 1, 10000, 9999999999
	stored.DisplayName = "updated profile"
	require.NoError(t, stored.Update(false))
	assert.Equal(t, inviter.Id, stored.InviterId)
	assert.Equal(t, created.CreatedAt, stored.CreatedAt)
	assert.Equal(t, created.ReferralRateBPS, stored.ReferralRateBPS)
	assert.Equal(t, created.ReferralExpiresAt, stored.ReferralExpiresAt)
}

func setupAffiliateTransferCompliance(t *testing.T) {
	t.Helper()
	previous := *operation_setting.GetPaymentSetting()
	operation_setting.GetPaymentSetting().ComplianceConfirmed = true
	operation_setting.GetPaymentSetting().ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
	t.Cleanup(func() { *operation_setting.GetPaymentSetting() = previous })
}

func TestAffiliateTransferConservesFundsAndPersistsRequestResult(t *testing.T) {
	setupAffiliateTransferCompliance(t)
	setupUserUpdateTestState(t)
	require.NoError(t, DB.AutoMigrate(&AffiliateTransfer{}))
	require.NoError(t, DB.Exec("DELETE FROM affiliate_transfers").Error)
	previousUnit := common.QuotaPerUnit
	common.QuotaPerUnit = 10
	t.Cleanup(func() { common.QuotaPerUnit = previousUnit })
	user := User{Username: "transfer-owner", AffCode: "transfer-code", Status: common.UserStatusEnabled, Quota: -5, AffQuota: 100, AffHistoryQuota: 200, DisplayName: "original"}
	require.NoError(t, DB.Create(&user).Error)
	require.NoError(t, DB.Model(&User{}).Where("id = ?", user.Id).Update("display_name", "concurrent profile edit").Error)
	requestID := "transfer-request-0001"
	result, err := user.TransferAffQuotaToQuota(25, requestID)
	require.NoError(t, err)
	require.NotZero(t, result.ID)
	assert.Equal(t, 25, result.Quota)
	repeated, err := user.TransferAffQuotaToQuota(25, requestID)
	require.NoError(t, err)
	assert.Equal(t, result.ID, repeated.ID)
	_, err = user.TransferAffQuotaToQuota(30, requestID)
	require.Error(t, err)
	known, err := GetAffiliateTransfer(user.Id, requestID)
	require.NoError(t, err)
	assert.Equal(t, result, known)
	other, err := GetAffiliateTransfer(user.Id+1, requestID)
	require.NoError(t, err)
	assert.Nil(t, other, "result lookups are scoped to the authenticated account")
	var stored User
	require.NoError(t, DB.First(&stored, user.Id).Error)
	assert.Equal(t, 20, stored.Quota)
	assert.Equal(t, 75, stored.AffQuota)
	assert.Equal(t, 200, stored.AffHistoryQuota)
	assert.Equal(t, "concurrent profile edit", stored.DisplayName)

	failure := errors.New("transfer result cannot be saved")
	require.NoError(t, DB.Callback().Create().Before("gorm:create").Register("invitation_transfer_failure", func(tx *gorm.DB) {
		if tx.Statement.Table == "affiliate_transfers" {
			tx.AddError(failure)
		}
	}))
	_, err = user.TransferAffQuotaToQuota(25, "transfer-request-0002")
	require.ErrorIs(t, err, failure)
	require.NoError(t, DB.Callback().Create().Remove("invitation_transfer_failure"))
	require.NoError(t, DB.First(&stored, user.Id).Error)
	assert.Equal(t, 20, stored.Quota)
	assert.Equal(t, 75, stored.AffQuota)
	missing, err := GetAffiliateTransfer(user.Id, "transfer-request-0002")
	require.NoError(t, err)
	assert.Nil(t, missing)

	require.NoError(t, DB.Model(&User{}).Where("id = ?", user.Id).Update("quota", common.MaxWalletQuota-5).Error)
	_, err = user.TransferAffQuotaToQuota(10, "transfer-request-0003")
	require.Error(t, err)
	require.NoError(t, DB.First(&stored, user.Id).Error)
	assert.Equal(t, common.MaxWalletQuota-5, stored.Quota)
	assert.Equal(t, 75, stored.AffQuota)
	_, err = user.TransferAffQuotaToQuota(100, "transfer-request-0004")
	require.Error(t, err)
	_, err = user.TransferAffQuotaToQuota(-10, "transfer-request-0005")
	require.Error(t, err)
	_, err = user.TransferAffQuotaToQuota(1, "transfer-request-0006")
	require.Error(t, err)
}

func TestAffiliateTransferCacheRecoveryUsesStoredIdentityAcrossDatabases(t *testing.T) {
	setupAffiliateTransferCompliance(t)
	if os.Getenv("NEW_API_REFERRAL_REDIS_ADDR") == "" {
		t.Skip("isolated Redis is not configured")
	}
	for _, testCase := range []string{"sqlite/lookup", "sqlite/retry", "sqlite/unknown", "mysql/lookup", "mysql/retry", "mysql/unknown", "postgres/lookup", "postgres/retry", "postgres/unknown"} {
		t.Run(testCase, func(t *testing.T) {
			dialect, recovery, _ := strings.Cut(testCase, "/")
			db, _ := newReferralIntegrationDatabase(t, dialect)
			previousDB, previousClient, previousEnabled, previousUnit := DB, common.RDB, common.RedisEnabled, common.QuotaPerUnit
			previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
			client := redis.NewClient(&redis.Options{Addr: os.Getenv("NEW_API_REFERRAL_REDIS_ADDR"), DB: 14, MaxRetries: -1})
			require.NoError(t, client.Ping(t.Context()).Err())
			DB, common.RDB, common.RedisEnabled, common.QuotaPerUnit = db, client, true, 1
			kind := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
			common.SetDatabaseTypes(kind, kind)
			user := User{Id: 100000000 + int(time.Now().UnixNano()%1000000000), Username: "round4-alias", AffCode: "round4-alias", Status: common.UserStatusEnabled, AffQuota: 100, AffHistoryQuota: 200}
			require.NoError(t, db.AutoMigrate(&User{}, &AffiliateTransfer{}))
			require.NoError(t, db.Create(&user).Error)
			keys := []string{getUserCacheKey(user.Id), getUserAuthFenceKey(user.Id), getUserAuthVersionKey(user.Id), getWalletCacheFillKey(user.Id)}
			t.Cleanup(func() {
				DB, common.RDB, common.RedisEnabled, common.QuotaPerUnit = previousDB, previousClient, previousEnabled, previousUnit
				common.SetDatabaseTypes(previousMain, previousLog)
				assert.NoError(t, client.Del(context.Background(), keys...).Err())
				assert.NoError(t, client.Close())
			})
			require.NoError(t, populateUserCache(user))
			unavailable := redis.NewClient(&redis.Options{Addr: os.Getenv("NEW_API_REFERRAL_REDIS_ADDR"), DB: 14, MaxRetries: -1})
			require.NoError(t, unavailable.Close())
			connection, err := db.DB()
			require.NoError(t, err)
			lookupBlocked := false
			lookupFailure := errors.New("isolated transfer result read unavailable")
			commitFailure := errors.New("isolated acknowledgment lost after actual commit")
			require.NoError(t, db.Callback().Query().Before("gorm:query").Register("stored_transfer_recovery_read", func(tx *gorm.DB) {
				if lookupBlocked && tx.Statement.Table == "affiliate_transfers" {
					tx.AddError(lookupFailure)
				}
			}))
			t.Cleanup(func() { assert.NoError(t, db.Callback().Query().Remove("stored_transfer_recovery_read")) })
			DB = db.Session(&gorm.Session{Context: t.Context()})
			DB.Statement.ConnPool = creditCommitPool{ConnPool: connection, afterCommit: func() error {
				common.RDB = unavailable
				if recovery == "unknown" {
					lookupBlocked = true
					return commitFailure
				}
				return nil
			}}
			const canonical = "Round4-Transfer-Identity"
			_, err = user.TransferAffQuotaToQuota(25, canonical)
			if recovery == "unknown" {
				require.ErrorIs(t, err, commitFailure)
				var rejected *AffiliateTransferRejectedError
				assert.False(t, errors.As(err, &rejected), "lost commit and failed lookup cannot become a definite rejection")
				unresolved, lookupErr := GetAffiliateTransfer(user.Id, canonical)
				assert.Nil(t, unresolved)
				assert.ErrorIs(t, lookupErr, lookupFailure, "unreadable result is not a successful not-found answer")
			} else {
				require.Error(t, err, "a committed transfer with unfinished cache credit remains retryable by its original identity")
				var rejected *AffiliateTransferRejectedError
				assert.False(t, errors.As(err, &rejected), "cache completion failure is not a definite financial rejection")
			}
			lookupBlocked = false
			DB, common.RDB = db, client
			cached, err := client.HGet(t.Context(), keys[0], "Quota").Int()
			require.NoError(t, err)
			require.Zero(t, cached, "real SQL commit must precede interrupted cache finalization")
			lookupID := canonical
			if dialect == "mysql" {
				lookupID = strings.ToLower(canonical)
			} else {
				missing, lookupErr := GetAffiliateTransfer(user.Id, strings.ToLower(canonical))
				require.NoError(t, lookupErr)
				assert.Nil(t, missing, "case-sensitive database identity remains unchanged")
			}
			var result *AffiliateTransfer
			if recovery == "lookup" || recovery == "unknown" {
				result, err = GetAffiliateTransfer(user.Id, lookupID)
			} else {
				result, err = user.TransferAffQuotaToQuota(25, lookupID)
			}
			require.NoError(t, err)
			require.NotNil(t, result)
			assert.Equal(t, canonical, result.RequestID)
			cached, err = client.HGet(t.Context(), keys[0], "Quota").Int()
			require.NoError(t, err)
			assert.Equal(t, 25, cached, "SQL identity aliases must finish the persisted identity's cache operation")
			repeated, err := user.TransferAffQuotaToQuota(25, canonical)
			require.NoError(t, err)
			assert.Equal(t, result.ID, repeated.ID)
			cached, err = client.HGet(t.Context(), keys[0], "Quota").Int()
			require.NoError(t, err)
			assert.Equal(t, 25, cached, "a later exact-identity retry cannot credit twice")
			_, mismatchErr := user.TransferAffQuotaToQuota(30, lookupID)
			require.Error(t, mismatchErr)
			var rejected *AffiliateTransferRejectedError
			assert.False(t, errors.As(mismatchErr, &rejected), "an existing different amount remains unresolved, not a fresh definite rejection")
			var count int64
			require.NoError(t, db.Model(&AffiliateTransfer{}).Where("user_id = ?", user.Id).Count(&count).Error)
			assert.EqualValues(t, 1, count)
			var persisted User
			require.NoError(t, db.First(&persisted, user.Id).Error)
			assert.Equal(t, 25, persisted.Quota)
			assert.Equal(t, 75, persisted.AffQuota)
			assert.Equal(t, 200, persisted.AffHistoryQuota)
		})
	}
}

func TestAffiliateTransferExistingIdentityPrecedesInvalidAmountAcrossDatabases(t *testing.T) {
	setupAffiliateTransferCompliance(t)
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db, _ := newReferralIntegrationDatabase(t, dialect)
			previousDB, previousUnit, previousRedis := DB, common.QuotaPerUnit, common.RedisEnabled
			previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
			DB, common.QuotaPerUnit, common.RedisEnabled = db, 1, false
			kind := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
			common.SetDatabaseTypes(kind, kind)
			t.Cleanup(func() {
				DB, common.QuotaPerUnit, common.RedisEnabled = previousDB, previousUnit, previousRedis
				common.SetDatabaseTypes(previousMain, previousLog)
			})
			require.NoError(t, db.AutoMigrate(&User{}, &AffiliateTransfer{}))
			owner := User{Username: "invalid-retry-owner", AffCode: "invalid-retry-owner", Status: common.UserStatusEnabled, AffQuota: 100, AffHistoryQuota: 200}
			other := User{Username: "invalid-retry-other", AffCode: "invalid-retry-other", Status: common.UserStatusEnabled, AffQuota: 100, AffHistoryQuota: 200}
			require.NoError(t, db.Create(&owner).Error)
			require.NoError(t, db.Create(&other).Error)
			const requestID = "Existing-Transfer-Invalid-Retry"
			original, err := owner.TransferAffQuotaToQuota(25, requestID)
			require.NoError(t, err)
			lookupID := requestID
			if dialect == "mysql" {
				lookupID = strings.ToLower(requestID)
			}
			for index, amount := range []int{-1, 0, common.MaxWalletQuota + 1} {
				result, err := owner.TransferAffQuotaToQuota(amount, lookupID)
				require.Error(t, err)
				assert.Nil(t, result)
				var rejected *AffiliateTransferRejectedError
				assert.False(t, errors.As(err, &rejected), "invalid retry amounts cannot erase a committed request identity")
				known, err := GetAffiliateTransfer(owner.Id, lookupID)
				require.NoError(t, err)
				require.NotNil(t, known)
				assert.Equal(t, original.ID, known.ID)
				assert.Equal(t, 25, known.Quota)
				newID := "new-rejected-transfer-" + strconv.Itoa(index)
				_, err = owner.TransferAffQuotaToQuota(amount, newID)
				require.Error(t, err)
				assert.True(t, errors.As(err, &rejected), "a new invalid amount is still a definite rejection")
				knownRejection, err := GetAffiliateTransfer(owner.Id, newID)
				require.ErrorAs(t, err, &rejected)
				assert.True(t, rejected.Persisted)
				require.NotNil(t, knownRejection)
				assert.Equal(t, amount, knownRejection.Quota)
			}
			otherResult, err := other.TransferAffQuotaToQuota(30, requestID)
			require.NoError(t, err)
			assert.NotEqual(t, original.ID, otherResult.ID, "the same request identity belongs independently to each account")
			known, err := GetAffiliateTransfer(owner.Id, lookupID)
			require.NoError(t, err)
			require.NotNil(t, known)
			assert.Equal(t, original.ID, known.ID)
			assert.Equal(t, 25, known.Quota)
			var current User
			require.NoError(t, db.First(&current, owner.Id).Error)
			assert.Equal(t, 25, current.Quota)
			assert.Equal(t, 75, current.AffQuota)
			assert.Equal(t, 200, current.AffHistoryQuota)
			var count int64
			require.NoError(t, db.Model(&AffiliateTransfer{}).Count(&count).Error)
			assert.EqualValues(t, 5, count)

			operation_setting.GetPaymentSetting().ComplianceConfirmed = false
			_, err = owner.TransferAffQuotaToQuota(10, "compliance-rejected-transfer")
			require.Error(t, err)
			var complianceRejection *AffiliateTransferRejectedError
			assert.True(t, errors.As(err, &complianceRejection))
			knownRejection, err := GetAffiliateTransfer(owner.Id, "compliance-rejected-transfer")
			require.ErrorAs(t, err, &complianceRejection)
			assert.True(t, complianceRejection.Persisted)
			require.NotNil(t, knownRejection)
			replayed, err := owner.TransferAffQuotaToQuota(25, lookupID)
			require.NoError(t, err, "a pause does not hide an already committed result")
			assert.Equal(t, original.ID, replayed.ID)
			_, err = owner.TransferAffQuotaToQuota(30, lookupID)
			require.Error(t, err)
			assert.False(t, errors.As(err, &complianceRejection), "a mismatched committed identity is not a new rejected operation")
			operation_setting.GetPaymentSetting().ComplianceConfirmed = true
			require.NoError(t, db.Model(&owner).Update("quota", common.MaxWalletQuota-5).Error)
			_, err = owner.TransferAffQuotaToQuota(10, "wallet-capacity-rejected-transfer")
			require.ErrorIs(t, err, ErrWalletQuotaLimitExceeded)
			var capacityRejection *AffiliateTransferRejectedError
			assert.True(t, errors.As(err, &capacityRejection), "a fresh request rejected before any write is a definite business rejection")
			knownRejection, err = GetAffiliateTransfer(owner.Id, "wallet-capacity-rejected-transfer")
			require.ErrorIs(t, err, ErrWalletQuotaLimitExceeded)
			require.ErrorAs(t, err, &capacityRejection)
			assert.True(t, capacityRejection.Persisted)
			require.NotNil(t, knownRejection)
			require.NoError(t, db.First(&current, owner.Id).Error)
			assert.Equal(t, common.MaxWalletQuota-5, current.Quota)
			assert.Equal(t, 75, current.AffQuota)
			assert.Equal(t, 200, current.AffHistoryQuota)
			replayed, err = owner.TransferAffQuotaToQuota(25, lookupID)
			require.NoError(t, err, "an existing committed identity still wins over the current capacity check")
			assert.Equal(t, original.ID, replayed.ID)
			require.NoError(t, db.Model(&AffiliateTransfer{}).Count(&count).Error)
			assert.EqualValues(t, 7, count)

			for _, field := range []string{"quota", "aff_quota"} {
				require.NoError(t, db.Model(&owner).Update(field, common.MaxWalletQuota+1).Error)
				_, err = owner.TransferAffQuotaToQuota(10, "corrupt-balance-"+field)
				require.ErrorIs(t, err, ErrWalletQuotaLimitExceeded)
				var rejected *AffiliateTransferRejectedError
				assert.False(t, errors.As(err, &rejected), "damaged stored balances remain an accounting error")
				missing, err := GetAffiliateTransfer(owner.Id, "corrupt-balance-"+field)
				require.NoError(t, err)
				assert.Nil(t, missing)
				require.NoError(t, db.Model(&owner).Updates(map[string]any{"quota": common.MaxWalletQuota - 5, "aff_quota": 75}).Error)
			}

			lookupFailure := errors.New("stored transfer identity lookup failed")
			require.NoError(t, db.Callback().Query().Before("gorm:query").Register("invalid_retry_lookup_failure", func(tx *gorm.DB) {
				if tx.Statement.Table == "affiliate_transfers" {
					tx.AddError(lookupFailure)
				}
			}))
			_, err = owner.TransferAffQuotaToQuota(-1, requestID)
			require.NoError(t, db.Callback().Query().Remove("invalid_retry_lookup_failure"))
			require.ErrorIs(t, err, lookupFailure)
			var rejected *AffiliateTransferRejectedError
			assert.False(t, errors.As(err, &rejected), "an unreadable original result cannot become a definite rejection")

			for index, amount := range []int{0, common.MaxWalletQuota + 1} {
				corrupt := AffiliateTransfer{UserID: owner.Id, RequestID: "corrupt-stored-transfer-" + strconv.Itoa(index), Quota: amount, CreatedAt: time.Now().Unix()}
				require.NoError(t, db.Create(&corrupt).Error)
				result, err := owner.TransferAffQuotaToQuota(amount, corrupt.RequestID)
				require.ErrorIs(t, err, ErrWalletQuotaLimitExceeded)
				assert.Nil(t, result)
				assert.False(t, errors.As(err, &rejected), "damaged durable amounts cannot be accepted as successful retries")
			}
		})
	}
}

func TestAffiliateTransferRejectedIdentityCannotBecomeMoney(t *testing.T) {
	setupAffiliateTransferCompliance(t)
	setupUserUpdateTestState(t)
	require.NoError(t, DB.AutoMigrate(&AffiliateTransfer{}))
	require.NoError(t, DB.Exec("DELETE FROM affiliate_transfers").Error)
	oldUnit := common.QuotaPerUnit
	common.QuotaPerUnit = 10
	t.Cleanup(func() { common.QuotaPerUnit = oldUnit })
	user := User{Username: "rejected-identity", AffCode: "rejected-identity", Status: common.UserStatusEnabled, Quota: 7, AffQuota: 5, AffHistoryQuota: 5}
	require.NoError(t, DB.Create(&user).Error)
	const requestID = "rejected-identity-replay"
	_, err := user.TransferAffQuotaToQuota(25, requestID)
	var rejected *AffiliateTransferRejectedError
	require.ErrorAs(t, err, &rejected)
	require.NoError(t, DB.Model(&user).Updates(map[string]any{"aff_quota": 105, "aff_history": 105}).Error)
	_, err = user.TransferAffQuotaToQuota(25, requestID)
	assert.ErrorAs(t, err, &rejected, "a delayed same-ID request must preserve the response that allowed the first page to release it")
	var current User
	require.NoError(t, DB.First(&current, user.Id).Error)
	assert.Equal(t, 7, current.Quota)
	assert.Equal(t, 105, current.AffQuota)
	assert.Equal(t, 105, current.AffHistoryQuota)
}
