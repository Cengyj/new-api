package controller

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/oauth"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/service/authz"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/alicebob/miniredis/v2"
	miniredisserver "github.com/alicebob/miniredis/v2/server"
	"github.com/go-redis/redis/v8"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func newControllerUserCacheMiniRedis(t *testing.T) *miniredis.Miniredis {
	t.Helper()
	server := miniredis.RunT(t)
	// miniredis lacks INFO server. Supply identity for the wallet-cache guard;
	// real Redis integration tests cover restart and persistence behavior.
	server.Server().SetPreHook(func(peer *miniredisserver.Peer, command string, args ...string) bool {
		if command == "INFO" && len(args) == 1 && args[0] == "server" {
			peer.WriteBulk("# Server\r\nrun_id:0123456789abcdef0123456789abcdef01234567\r\n")
			return true
		}
		return false
	})
	return server
}

func setupManageUserTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	require.NoError(t, i18n.Init())
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousRedisEnabled, previousSecret := common.RedisEnabled, common.SessionSecret
	previousMainDatabaseType, previousLogDatabaseType := common.MainDatabaseType(), common.LogDatabaseType()
	dialect := os.Getenv("TEST_MANAGE_USER_DIALECT")
	if dialect == "" {
		dialect = "sqlite"
	}
	databaseTypes := map[string]common.DatabaseType{
		"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL,
	}
	require.Contains(t, databaseTypes, dialect)
	dsn := os.Getenv("TEST_" + strings.ToUpper(dialect) + "_DSN")
	db, _ := newAuditTestDatabase(t, dialect, dsn)
	logDB := db
	if os.Getenv("TEST_MANAGE_USER_SEPARATE_LOG_DB") == "1" {
		logDB, _ = newAuditTestDatabase(t, dialect, dsn)
	}
	model.DB, model.LOG_DB = db, logDB
	common.RedisEnabled = false
	common.SessionSecret = "manage-user-test-secret"
	common.SetDatabaseTypes(databaseTypes[dialect], databaseTypes[dialect])

	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.RedisEnabled, common.SessionSecret = previousRedisEnabled, previousSecret
		common.SetDatabaseTypes(previousMainDatabaseType, previousLogDatabaseType)
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
		if logDB != db {
			sqlLogDB, err := logDB.DB()
			if err == nil {
				_ = sqlLogDB.Close()
			}
		}
	})
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserSession{}, &model.CasbinRule{}, &model.AuthzRole{}, &model.AuthFlow{}, &model.TwoFA{}, &model.PasskeyCredential{}, &model.UserAccessToken{}))
	require.NoError(t, logDB.AutoMigrate(&model.Log{}, &model.AuditLog{}))
	versionQuery := "SELECT version()"
	if dialect == "sqlite" {
		versionQuery = "SELECT sqlite_version()"
	}
	var version string
	require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
	t.Logf("database: %s %s, separate log database: %v", dialect, version, logDB != db)
	return db
}

func performManageUserRequest(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	return performVerifiedManageUserRequest(t, body, service.AuthIdentity{UserID: 9999}, "")
}

// performVerifiedManageUserRequest drives ManageUser as the root operator from
// a dashboard login session, carrying the step-up proof status or role changes need.
func performVerifiedManageUserRequest(t *testing.T, body string, identity service.AuthIdentity, proof string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/user/manage", strings.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	if proof != "" {
		c.Request.Header.Set("X-Security-Proof", proof)
	}
	c.Set("id", identity.UserID)
	c.Set("role", common.RoleRootUser)
	c.Set("username", "root-operator")
	c.Set("session_id", identity.SessionID)
	c.Set("auth_version", identity.UserAuthVersion)
	c.Set("session_version", identity.SessionVersion)
	c.Set(common.RequestIdKey, "quota-test-request")
	ManageUser(c)
	return recorder
}

// manageUserProof signs the root operator in and issues a password-method proof
// bound to one ManageUser operation.
func manageUserProof(t *testing.T, db *gorm.DB, operation service.VerificationOperation) (service.AuthIdentity, string) {
	t.Helper()
	operator := createQuotaTestOperator(t, db, common.RoleRootUser)
	require.NoError(t, model.PublishUserAuthCache(operator.Id))
	bundle, err := service.CreateLoginSession(operator.Id, "password", "127.0.0.1", "manage-user-test")
	require.NoError(t, err)
	identity, err := service.ParseAccessToken(bundle.AccessToken)
	require.NoError(t, err)
	binding, err := service.BindVerificationOperation(operation)
	require.NoError(t, err)
	proof, _, err := service.IssueSecurityProof(identity, service.VerificationMethodPassword, binding)
	require.NoError(t, err)
	return identity, proof
}

func TestManageUserDisableAdvancesAuthVersionOnceAndRevokesSession(t *testing.T) {
	db := setupManageUserTestDB(t)
	now := time.Now().Unix()
	user := model.User{
		Username: "managed-disable-user", Password: "password", Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1,
	}
	require.NoError(t, db.Create(&user).Error)
	require.NoError(t, db.Create(&model.UserSession{
		SID: "managed-disable-session", UserID: user.Id, Version: 1, UserAuthVersion: 1,
		Status: model.UserSessionStatusActive, RefreshHash: "refresh-hash", LoginMethod: "password",
		LastActiveAt: now, ExpiresAt: now + 3600,
	}).Error)

	identity, proof := manageUserProof(t, db, service.VerificationOperation{Scope: service.VerificationScopeAdminUserManage, Context: []byte(fmt.Sprintf(`{"user_id":%d,"action":"disable"}`, user.Id))})
	recorder := performVerifiedManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"disable"}`, user.Id), identity, proof)
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"success":true`)

	var updated model.User
	require.NoError(t, db.First(&updated, user.Id).Error)
	assert.Equal(t, common.UserStatusDisabled, updated.Status)
	assert.EqualValues(t, 2, updated.AuthVersion)
	var session model.UserSession
	require.NoError(t, db.First(&session, "sid = ?", "managed-disable-session").Error)
	assert.Equal(t, model.UserSessionStatusRevoked, session.Status)
}

func TestManageUserDemoteAdvancesAuthVersionAndRevokesSessionsOnce(t *testing.T) {
	db := setupManageUserTestDB(t)
	previousMaster := common.IsMasterNode
	common.IsMasterNode = false
	t.Cleanup(func() { common.IsMasterNode = previousMaster })
	require.NoError(t, authz.Init(db))

	now := time.Now().Unix()
	user := model.User{
		Username: "managed-demote-user", Password: "password", Role: common.RoleAdminUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1,
	}
	require.NoError(t, db.Create(&user).Error)
	for _, sid := range []string{"managed-demote-session-one", "managed-demote-session-two"} {
		require.NoError(t, db.Create(&model.UserSession{
			SID: sid, UserID: user.Id, Version: 1, UserAuthVersion: 1,
			Status: model.UserSessionStatusActive, RefreshHash: "refresh-" + sid, LoginMethod: "password",
			LastActiveAt: now, ExpiresAt: now + 3600,
		}).Error)
	}

	sessionUpdateCount := 0
	require.NoError(t, db.Callback().Update().Before("gorm:update").Register("test:count_demote_session_updates", func(tx *gorm.DB) {
		if tx.Statement != nil && tx.Statement.Table == "user_sessions" {
			sessionUpdateCount++
		}
	}))

	identity, proof := manageUserProof(t, db, service.VerificationOperation{Scope: service.VerificationScopeAdminUserManage, Context: []byte(fmt.Sprintf(`{"user_id":%d,"action":"demote"}`, user.Id))})
	recorder := performVerifiedManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"demote"}`, user.Id), identity, proof)
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"success":true`)

	var updated model.User
	require.NoError(t, db.First(&updated, user.Id).Error)
	assert.Equal(t, common.RoleCommonUser, updated.Role)
	assert.EqualValues(t, 2, updated.AuthVersion)
	var sessions []model.UserSession
	require.NoError(t, db.Where("user_id = ?", user.Id).Order("sid asc").Find(&sessions).Error)
	require.Len(t, sessions, 2)
	for _, session := range sessions {
		assert.Equal(t, model.UserSessionStatusRevoked, session.Status)
		assert.Equal(t, "admin_demote", session.RevokedReason)
	}
	assert.Equal(t, 1, sessionUpdateCount)
}

func TestManageUserDeleteReturnsImmediatelyAndUnknownActionFails(t *testing.T) {
	db := setupManageUserTestDB(t)
	deleted := model.User{
		Username: "managed-delete-user", Password: "password", Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1, AffCode: "delete-aff",
	}
	require.NoError(t, db.Create(&deleted).Error)

	identity, proof := manageUserProof(t, db, service.VerificationOperation{Scope: service.VerificationScopeAdminUserDelete, Context: []byte(fmt.Sprintf(`{"user_id":%d}`, deleted.Id))})
	recorder := performVerifiedManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"delete"}`, deleted.Id), identity, proof)
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	var deletedCount int64
	require.NoError(t, db.Unscoped().Model(&model.User{}).Where("id = ? AND deleted_at IS NOT NULL", deleted.Id).Count(&deletedCount).Error)
	assert.EqualValues(t, 1, deletedCount)

	unchanged := model.User{
		Username: "managed-unknown-user", Password: "password", Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1, AffCode: "unknown-aff",
	}
	require.NoError(t, db.Create(&unchanged).Error)
	recorder = performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"unknown"}`, unchanged.Id))
	assert.Contains(t, recorder.Body.String(), `"success":false`)
	require.NoError(t, db.First(&unchanged, unchanged.Id).Error)
	assert.EqualValues(t, 1, unchanged.AuthVersion)
	assert.Equal(t, common.UserStatusEnabled, unchanged.Status)
}

func createQuotaTestOperator(t *testing.T, db *gorm.DB, role int) model.User {
	t.Helper()
	if role == 0 {
		role = common.RoleRootUser
	}
	operator := model.User{Id: 9999, Username: "root-operator", Password: "root-operator-hash", Role: role, Status: common.UserStatusEnabled, AuthVersion: 1, AffCode: "root-operator-aff"}
	require.NoError(t, db.Create(&operator).Error)
	return operator
}

func TestManageUserQuotaRecordsTopupAndAudit(t *testing.T) {
	for _, tc := range []struct {
		name, mode, action, content string
		value, wantQuota            int
	}{
		{"add", "add", "user.quota_add", "Increased user quota by 500", 500, 1500},
		{"subtract", "subtract", "user.quota_subtract", "Decreased user quota by 500", 500, 500},
		{"override_up", "override", "user.quota_override", "Overrode user quota from 1000 to 1500", 1500, 1500},
		{"override_down", "override", "user.quota_override", "Overrode user quota from 1000 to 500", 500, 500},
		{"override_unchanged", "override", "user.quota_override", "Overrode user quota from 1000 to 1000", 1000, 1000},
		{"override_zero", "override", "user.quota_override", "Overrode user quota from 1000 to 0", 0, 0},
		{"override_negative", "override", "user.quota_override", "Overrode user quota from 1000 to -1", -1, -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			user := model.User{Username: "quota-owner", Role: common.RoleCommonUser, Quota: 1000, AffCode: "quota-owner-aff"}
			require.NoError(t, db.Create(&user).Error)
			createQuotaTestOperator(t, db, common.RoleRootUser)

			recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":%q,"value":%d}`, user.Id, tc.mode, tc.value))
			assert.Equal(t, http.StatusOK, recorder.Code)
			require.Contains(t, recorder.Body.String(), `"success":true`)
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, tc.wantQuota, user.Quota)

			logs, total, err := model.GetAllLogs(model.LogFilter{Type: model.LogTypeTopup}, 0, 20)
			require.NoError(t, err)
			assert.EqualValues(t, 1, total)
			require.Len(t, logs, 1)
			assert.Equal(t, user.Id, logs[0].UserId)
			assert.Equal(t, user.Username, logs[0].Username)
			assert.Equal(t, tc.content, logs[0].Content)
			model.FormatAdminLogs(logs)
			var other model.AuditOther
			require.NoError(t, common.UnmarshalJsonStr(logs[0].Other, &other))
			assert.Equal(t, &model.AuditAdminInfo{AdminID: 9999, AdminUsername: "root-operator", AdminRole: common.RoleRootUser, AuthMethod: "session"}, other.AdminInfo)

			logs, total, err = model.GetUserLogs(user.Id, model.LogFilter{Type: model.LogTypeTopup}, 0, 20)
			require.NoError(t, err)
			assert.EqualValues(t, 1, total)
			require.Len(t, logs, 1)
			other = model.AuditOther{}
			require.NoError(t, common.UnmarshalJsonStr(logs[0].Other, &other))
			assert.Nil(t, other.AdminInfo)
			require.NotNil(t, other.Op)
			assert.Equal(t, tc.action, other.Op.Action)
			params, err := common.Marshal(other.Op.Params)
			require.NoError(t, err)
			expectedParams := model.AuditFields{"target_user_id": user.Id, "target_username": user.Username, "mode": tc.mode, "requested_quota": tc.value, "from": 1000, "to": tc.wantQuota}
			if tc.mode != "override" {
				expectedParams["quota"] = tc.value
			}
			expected, err := common.Marshal(expectedParams)
			require.NoError(t, err)
			assert.JSONEq(t, string(expected), string(params))
			assert.Equal(t, "quota-test-request", logs[0].RequestId)
			assert.Empty(t, logs[0].Ip, "recipient logs must not disclose the administrator IP")

			logs, total, err = model.GetUserLogs(9999, model.LogFilter{Type: model.LogTypeTopup}, 0, 20)
			require.NoError(t, err)
			assert.Zero(t, total)
			assert.Empty(t, logs)
			var audits []model.AuditLog
			require.NoError(t, model.LOG_DB.Find(&audits).Error)
			require.Len(t, audits, 1)
			assert.Equal(t, 9999, audits[0].UserId)
			assert.Equal(t, "root-operator", audits[0].Username)
			assert.Equal(t, tc.action, audits[0].Action)
			assert.True(t, audits[0].Success)
			params, err = common.Marshal(audits[0].Other.Op.Params)
			require.NoError(t, err)
			assert.JSONEq(t, string(expected), string(params))
			assert.Equal(t, "quota-test-request", audits[0].RequestId)
		})
	}
}

func TestManageUserQuotaFailuresDoNotRecordTopup(t *testing.T) {
	for _, tc := range []struct {
		name, mode string
		value      int
		failUpdate bool
	}{
		{"zero_add", "add", 0, false},
		{"negative_subtract", "subtract", -1, false},
		{"invalid_mode", "invalid", 500, false},
		{"add_update_error", "add", 500, true},
		{"subtract_update_error", "subtract", 500, true},
		{"override_update_error", "override", 500, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			createQuotaTestOperator(t, db, common.RoleRootUser)
			user := model.User{Username: "quota-owner", Role: common.RoleCommonUser, Quota: 1000}
			require.NoError(t, db.Create(&user).Error)
			if tc.failUpdate {
				require.NoError(t, db.Callback().Update().Before("gorm:update").Register("test:fail_quota_update", func(tx *gorm.DB) {
					if tx.Statement.Table == "users" {
						tx.AddError(errors.New("quota update unavailable"))
					}
				}))
			}
			recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":%q,"value":%d}`, user.Id, tc.mode, tc.value))
			assert.Contains(t, recorder.Body.String(), `"success":false`)
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, 1000, user.Quota)
			var logCount, auditCount int64
			require.NoError(t, model.LOG_DB.Model(&model.Log{}).Count(&logCount).Error)
			require.NoError(t, model.LOG_DB.Model(&model.AuditLog{}).Count(&auditCount).Error)
			assert.Zero(t, logCount)
			assert.EqualValues(t, 1, auditCount)
			var audit model.AuditLog
			require.NoError(t, model.LOG_DB.First(&audit).Error)
			assert.False(t, audit.Success)
			params, err := common.Marshal(audit.Other.Op.Params)
			require.NoError(t, err)
			assert.NotContains(t, string(params), `"from"`)
			assert.NotContains(t, string(params), `"to"`)
			assert.NotContains(t, string(params), `"target_username"`)
			assert.NotContains(t, string(params), "quota update unavailable")
			reason := "invalid_parameters"
			if tc.failUpdate {
				reason = "database_error"
			}
			assert.Contains(t, string(params), `"failure_reason":"`+reason+`"`)
			assert.Contains(t, string(params), fmt.Sprintf(`"requested_quota":%d`, tc.value))
		})
	}
}

func TestManageUserQuotaLogFailureKeepsSuccessfulAdjustment(t *testing.T) {
	for _, failedTable := range []string{"logs", "audit_logs"} {
		t.Run(failedTable, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			createQuotaTestOperator(t, db, common.RoleRootUser)
			user := model.User{Username: "quota-owner", Role: common.RoleCommonUser, Quota: 1000}
			require.NoError(t, db.Create(&user).Error)
			require.NoError(t, model.LOG_DB.Callback().Create().Before("gorm:create").Register("test:fail_quota_log", func(tx *gorm.DB) {
				if tx.Statement.Table == failedTable {
					tx.AddError(errors.New("quota log unavailable"))
				}
			}))
			recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":"add","value":500}`, user.Id))
			assert.Contains(t, recorder.Body.String(), `"success":true`)
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, 1500, user.Quota)
			var logCount, auditCount int64
			require.NoError(t, model.LOG_DB.Model(&model.Log{}).Count(&logCount).Error)
			require.NoError(t, model.LOG_DB.Model(&model.AuditLog{}).Count(&auditCount).Error)
			if failedTable == "logs" {
				assert.Zero(t, logCount)
				assert.EqualValues(t, 1, auditCount)
			} else {
				assert.EqualValues(t, 1, logCount)
				assert.Zero(t, auditCount)
			}
		})
	}
}

func TestManageUserQuotaTargetsAndWalletBounds(t *testing.T) {
	for _, tc := range []struct {
		name, mode, reason                                string
		before, value, targetID, targetRole, operatorRole int
		deleted, failRead                                 bool
	}{
		{name: "zero_id", mode: "add", value: 1, reason: "invalid_parameters"},
		{name: "negative_id", mode: "subtract", value: 1, targetID: -1, reason: "invalid_parameters"},
		{name: "missing", mode: "override", value: 1, targetID: 12345, reason: "target_not_found"},
		{name: "deleted", mode: "add", value: 1, targetID: 1, deleted: true, reason: "target_not_found"},
		{name: "peer_admin", mode: "add", value: 1, targetID: 1, targetRole: common.RoleAdminUser, operatorRole: common.RoleAdminUser, reason: "permission_denied"},
		{name: "higher_role", mode: "override", value: 1, targetID: 1, targetRole: common.RoleRootUser, operatorRole: common.RoleAdminUser, reason: "permission_denied"},
		{name: "read_error", mode: "add", value: 1, targetID: 1, failRead: true, reason: "database_error"},
		{name: "add_overflow", mode: "add", before: common.MaxWalletQuota, value: 1, targetID: 1, reason: "quota_limit_exceeded"},
		{name: "subtract_underflow", mode: "subtract", before: -common.MaxWalletQuota, value: 1, targetID: 1, reason: "quota_limit_exceeded"},
		{name: "oversized_add", mode: "add", value: common.MaxWalletQuota + 1, targetID: 1, reason: "quota_limit_exceeded"},
		{name: "oversized_subtract", mode: "subtract", value: common.MaxWalletQuota + 1, targetID: 1, reason: "quota_limit_exceeded"},
		{name: "oversized_override", mode: "override", value: -common.MaxWalletQuota - 1, targetID: 1, reason: "quota_limit_exceeded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			createQuotaTestOperator(t, db, tc.operatorRole)
			user := model.User{Id: 1, Username: "private-target-name", Role: tc.targetRole, Quota: tc.before}
			require.NoError(t, db.Create(&user).Error)
			if tc.deleted {
				require.NoError(t, db.Delete(&user).Error)
			}
			if tc.failRead {
				require.NoError(t, db.Callback().Query().Before("gorm:query").Register("test:quota_read_error", func(tx *gorm.DB) {
					if tx.Statement.Table == "users" && len(tx.Statement.Selects) == 0 {
						tx.AddError(errors.New("private database error"))
					}
				}))
			}
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodPost, "/api/user/manage", strings.NewReader(fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":%q,"value":%d}`, tc.targetID, tc.mode, tc.value)))
			role := tc.operatorRole
			if role == 0 {
				role = common.RoleRootUser
			}
			c.Set("id", 9999)
			c.Set("role", role)
			ManageUser(c)
			require.Contains(t, recorder.Body.String(), `"success":false`)
			if tc.failRead {
				require.NoError(t, db.Callback().Query().Remove("test:quota_read_error"))
			}
			require.NoError(t, db.Unscoped().First(&user, user.Id).Error)
			assert.Equal(t, tc.before, user.Quota)
			var audits []model.AuditLog
			require.NoError(t, model.LOG_DB.Find(&audits).Error)
			require.Len(t, audits, 1)
			assert.False(t, audits[0].Success)
			params, err := common.Marshal(audits[0].Other.Op.Params)
			require.NoError(t, err)
			expected, err := common.Marshal(model.AuditFields{"target_user_id": tc.targetID, "mode": tc.mode, "requested_quota": tc.value, "failure_reason": tc.reason})
			require.NoError(t, err)
			assert.JSONEq(t, string(expected), string(params))
			assert.NotContains(t, audits[0].Content, user.Username)
			var count int64
			require.NoError(t, model.LOG_DB.Model(&model.Log{}).Count(&count).Error)
			assert.Zero(t, count)
		})
	}
}

func TestManageUserQuotaMiddlewareKeepsOneOperationPerRequest(t *testing.T) {
	db := setupManageUserTestDB(t)
	pat := "quota-middleware-test-token"
	operator := model.User{Id: 9999, Username: "root-operator", Role: common.RoleRootUser, Status: common.UserStatusEnabled, AuthVersion: 1, AccessToken: &pat, Quota: 1000}
	require.NoError(t, db.Create(&operator).Error)
	router := gin.New()
	router.Use(middleware.RequestId(), middleware.AccessTokenAudit())
	router.POST("/api/user/manage", middleware.AdminAuth(), ManageUser)
	for _, tc := range []struct {
		body, action string
		success      bool
	}{
		{`{"id":9999,"action":"add_quota","mode":"add","value":100}`, "user.quota_add", true},
		{`{"id":9999,"action":"add_quota","mode":"subtract","value":0}`, "user.quota_subtract", false},
		{`{"id":9999,"action":"add_quota","mode":"invalid","value":1}`, "generic", false},
		{`{"id":`, "generic", false},
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/user/manage", strings.NewReader(tc.body))
		request.Header.Set("Authorization", "Bearer "+pat)
		request.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(recorder, request)
		assert.Equal(t, http.StatusOK, recorder.Code)
		assert.Contains(t, recorder.Body.String(), fmt.Sprintf(`"success":%t`, tc.success))
		requestID := recorder.Header().Get(common.RequestIdKey)
		require.NotEmpty(t, requestID)
		var audits []model.AuditLog
		require.NoError(t, model.LOG_DB.Where("request_id = ?", requestID).Find(&audits).Error)
		require.Len(t, audits, 2, "one operation audit and one PAT request audit")
		for _, audit := range audits {
			assert.Equal(t, tc.success, audit.Success)
			if audit.Category != model.AuditCategoryOperation {
				continue
			}
			assert.Equal(t, tc.action, audit.Action)
			assert.Equal(t, operator.Id, audit.UserId)
			assert.Equal(t, "/api/user/manage", audit.Route)
			if tc.success {
				params, err := common.Marshal(audit.Other.Op.Params)
				require.NoError(t, err)
				assert.Contains(t, string(params), `"target_user_id":9999`)
				assert.Contains(t, string(params), `"target_username":"root-operator"`)
			}
		}
		var count int64
		require.NoError(t, model.LOG_DB.Model(&model.Log{}).Where("request_id = ?", requestID).Count(&count).Error)
		if tc.success {
			assert.EqualValues(t, 1, count)
		} else {
			assert.Zero(t, count)
		}
	}
	require.NoError(t, db.First(&operator, operator.Id).Error)
	assert.Equal(t, 1100, operator.Quota)
}

func TestManageUserQuotaConcurrentSnapshots(t *testing.T) {
	db := setupManageUserTestDB(t)
	user := model.User{Username: "concurrent-quota", Quota: 1000}
	require.NoError(t, db.Create(&user).Error)
	var ready sync.WaitGroup
	ready.Add(2)
	release := make(chan struct{})
	require.NoError(t, db.Callback().Query().Before("gorm:query").Register("test:concurrent_quota_start", func(tx *gorm.DB) {
		if tx.Statement.Table == "users" {
			ready.Done()
			<-release
		}
	}))
	type result struct {
		adjustment *model.UserQuotaAdjustment
		err        error
		value      int
	}
	results := make(chan result, 2)
	for _, value := range []int{10, 20} {
		go func(value int) {
			adjustment, err := model.AdjustUserQuota(user.Id, common.RoleRootUser, "add", value)
			results <- result{adjustment, err, value}
		}(value)
	}
	ready.Wait()
	close(release)
	var committed []model.UserQuotaAdjustment
	for range 2 {
		result := <-results
		if result.err != nil {
			require.True(t, common.UsingMainDatabase(common.DatabaseTypeSQLite), "row-locking databases must serialize both adjustments: %v", result.err)
			assert.Contains(t, strings.ToLower(result.err.Error()), "locked")
			assert.Nil(t, result.adjustment)
			continue
		}
		require.NotNil(t, result.adjustment)
		assert.Equal(t, result.value, result.adjustment.After-result.adjustment.Before)
		committed = append(committed, *result.adjustment)
	}
	require.NoError(t, db.Callback().Query().Remove("test:concurrent_quota_start"))
	require.NotEmpty(t, committed)
	sort.Slice(committed, func(i, j int) bool { return committed[i].Before < committed[j].Before })
	balance := 1000
	for _, adjustment := range committed {
		assert.Equal(t, balance, adjustment.Before)
		balance = adjustment.After
	}
	require.NoError(t, db.First(&user, user.Id).Error)
	assert.Equal(t, balance, user.Quota)
}

func TestManageUserQuotaCacheUsesCommittedIntegerDifference(t *testing.T) {
	for _, tc := range []struct {
		name, mode                               string
		before, cached, value, after, wantCached int
		failUpdate, failCache, missingCache      bool
	}{
		{name: "add_preserves_reservations", mode: "add", before: 1000, cached: 900, value: 500, after: 1500, wantCached: 1400},
		{name: "subtract_preserves_reservations", mode: "subtract", before: 1000, cached: 900, value: 500, after: 500, wantCached: 400},
		{name: "override_preserves_reservations", mode: "override", before: 1000, cached: 900, value: 2000, after: 2000, wantCached: 1900},
		{name: "large_odd_difference", mode: "override", before: common.MaxWalletQuota - 1, cached: common.MaxWalletQuota - 1, value: -common.MaxWalletQuota, after: -common.MaxWalletQuota, wantCached: -common.MaxWalletQuota},
		{name: "rollback_does_not_change_cache", mode: "subtract", before: 1000, cached: 900, value: 500, after: 1000, wantCached: 900, failUpdate: true},
		{name: "cache_error_keeps_committed_change", mode: "add", before: 1000, value: 500, after: 1500, failCache: true},
		{name: "missing_cache_is_not_partially_created", mode: "add", before: 1000, value: 500, after: 1500, missingCache: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			operator := createQuotaTestOperator(t, db, common.RoleRootUser)
			server := newControllerUserCacheMiniRedis(t)
			oldRDB := common.RDB
			common.RDB = redis.NewClient(&redis.Options{Addr: server.Addr(), MaxRetries: -1})
			common.RedisEnabled = true
			t.Cleanup(func() { _ = common.RDB.Close(); common.RDB = oldRDB })
			user := model.User{Username: "cached-quota", Quota: tc.before, AuthVersion: 1}
			require.NoError(t, db.Create(&user).Error)
			cache, err := model.GetUserCache(user.Id)
			require.NoError(t, err)
			assert.Equal(t, tc.before, cache.Quota)
			_, err = model.GetUserCache(operator.Id)
			require.NoError(t, err)
			keys := server.Keys()
			var quotaKey string
			for _, key := range keys {
				if server.HGet(key, "Id") == strconv.Itoa(user.Id) && server.HGet(key, "Quota") != "" {
					quotaKey = key
					break
				}
			}
			require.NotEmpty(t, quotaKey)
			server.HSet(quotaKey, "Quota", strconv.Itoa(tc.cached))
			if tc.missingCache {
				server.Del(quotaKey)
			}
			if tc.failCache {
				server.SetError("ERR quota cache unavailable")
			}
			if tc.failUpdate {
				require.NoError(t, db.Callback().Update().After("gorm:update").Register("test:cache_quota_rollback", func(tx *gorm.DB) {
					if tx.Statement.Table == "users" {
						tx.AddError(errors.New("quota rollback"))
					}
				}))
			}
			recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":%q,"value":%d}`, user.Id, tc.mode, tc.value))
			assert.Contains(t, recorder.Body.String(), fmt.Sprintf(`"success":%t`, !tc.failUpdate))
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, tc.after, user.Quota)
			if tc.missingCache {
				// Log username lookup may hydrate the whole user after commit.
				if server.Exists(quotaKey) {
					assert.Equal(t, strconv.Itoa(user.Id), server.HGet(quotaKey, "Id"))
					assert.NotEmpty(t, server.HGet(quotaKey, "CacheSchema"))
					assert.Equal(t, strconv.Itoa(tc.after), server.HGet(quotaKey, "Quota"))
				}
			} else if !tc.failCache {
				assert.Equal(t, strconv.Itoa(tc.wantCached), server.HGet(quotaKey, "Quota"))
			}
		})
	}
}

// Saving notification settings starts from what the user stored: fields the
// form does not manage stay, and switches an older client leaves out keep
// their stored values. Only administrators change the channel and upstream
// switches, and a threshold of 0 means the site default.
func TestUpdateUserSettingKeepsWhatTheRequestLeavesOut(t *testing.T) {
	on, off := true, false
	stored := dto.UserSetting{
		NotifyType:                       dto.NotifyTypeBark,
		BarkUrl:                          "https://api.day.app/key/{{title}}/{{content}}",
		QuotaWarningThreshold:            500000,
		QuotaWarningEnabled:              &off,
		ChannelNotifyEnabled:             &on,
		UpstreamModelUpdateNotifyEnabled: true,
		Language:                         "zhCN",
		SidebarModules:                   `{"chat":{"enabled":true}}`,
		BillingPreference:                "wallet_only",
	}
	kept := func(setting dto.UserSetting) dto.UserSetting {
		setting.Language, setting.SidebarModules, setting.BillingPreference = stored.Language, stored.SidebarModules, stored.BillingPreference
		return setting
	}
	switchesChanged := `{"notify_type":"email","quota_warning_threshold":0,"quota_warning_enabled":true,"channel_notify_enabled":false,"upstream_model_update_notify_enabled":false}`
	for _, tc := range []struct {
		name        string
		role        int
		body        string
		wantSuccess bool
		want        dto.UserSetting
	}{
		{
			name:        "older client without the new switches",
			role:        common.RoleAdminUser,
			body:        `{"notify_type":"webhook","quota_warning_threshold":2000,"webhook_url":"https://example.com/hook","webhook_secret":"hook-secret","accept_unset_model_ratio_model":true,"record_ip_log":true}`,
			wantSuccess: true,
			want: kept(dto.UserSetting{
				NotifyType: dto.NotifyTypeWebhook, WebhookUrl: "https://example.com/hook", WebhookSecret: "hook-secret",
				QuotaWarningThreshold: 2000, QuotaWarningEnabled: &off, ChannelNotifyEnabled: &on, UpstreamModelUpdateNotifyEnabled: true,
				AcceptUnsetRatioModel: true, RecordIpLog: true,
			}),
		},
		{
			name:        "administrator changes the switches and uses the site default threshold",
			role:        common.RoleAdminUser,
			body:        switchesChanged,
			wantSuccess: true,
			want:        kept(dto.UserSetting{NotifyType: dto.NotifyTypeEmail, QuotaWarningEnabled: &on, ChannelNotifyEnabled: &off}),
		},
		{
			name:        "user cannot change the administrator switches",
			role:        common.RoleCommonUser,
			body:        switchesChanged,
			wantSuccess: true,
			want:        kept(dto.UserSetting{NotifyType: dto.NotifyTypeEmail, QuotaWarningEnabled: &on, ChannelNotifyEnabled: &on, UpstreamModelUpdateNotifyEnabled: true}),
		},
		{
			name: "negative threshold",
			role: common.RoleCommonUser,
			body: `{"notify_type":"email","quota_warning_threshold":-1}`,
			want: stored,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			setting, err := common.Marshal(stored)
			require.NoError(t, err)
			user := model.User{Username: "setting-owner", Role: tc.role, Status: common.UserStatusEnabled, AffCode: "setting-owner-aff", Setting: string(setting)}
			require.NoError(t, db.Create(&user).Error)

			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodPut, "/api/user/setting", strings.NewReader(tc.body))
			c.Request.Header.Set("Content-Type", "application/json")
			c.Set("id", user.Id)
			UpdateUserSetting(c)

			assert.Contains(t, recorder.Body.String(), fmt.Sprintf(`"success":%t`, tc.wantSuccess))
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, tc.want, user.GetSetting())
		})
	}
}

func setupInvitationRegistrationController(t *testing.T) model.User {
	t.Helper()
	db := setupManageUserTestDB(t)
	require.NoError(t, db.AutoMigrate(&model.Option{}, &model.AffiliateTransfer{}, &model.UserOAuthBinding{}))
	require.NoError(t, model.InitializeReferralRebateRule(db))
	previousPayment := *operation_setting.GetPaymentSetting()
	previousRegister, previousPassword, previousVerify := common.RegisterEnabled, common.PasswordRegisterEnabled, common.EmailVerificationEnabled
	previousDefaultToken := constant.GenerateDefaultToken
	previousNew, previousInvitee, previousInviter := common.QuotaForNewUser, common.QuotaForInvitee, common.QuotaForInviter
	payment := operation_setting.GetPaymentSetting()
	payment.ComplianceConfirmed = true
	payment.ComplianceTermsVersion = operation_setting.CurrentComplianceTermsVersion
	common.RegisterEnabled, common.PasswordRegisterEnabled, common.EmailVerificationEnabled = true, true, false
	constant.GenerateDefaultToken = false
	common.QuotaForNewUser, common.QuotaForInvitee, common.QuotaForInviter = 20, 30, 40
	t.Cleanup(func() {
		*payment = previousPayment
		common.RegisterEnabled, common.PasswordRegisterEnabled, common.EmailVerificationEnabled = previousRegister, previousPassword, previousVerify
		constant.GenerateDefaultToken = previousDefaultToken
		common.QuotaForNewUser, common.QuotaForInvitee, common.QuotaForInviter = previousNew, previousInvitee, previousInviter
	})
	require.NoError(t, model.SaveReferralRebateRule(model.ReferralRebateRule{Enabled: true, RateBPS: 1000, ValidDays: 2}))
	inviter := model.User{Username: "invitation-owner", AffCode: "invite-original", Status: common.UserStatusEnabled, AffQuota: 100, AffHistoryQuota: 200}
	require.NoError(t, db.Create(&inviter).Error)
	return inviter
}

func TestInvitationPasswordRegistrationEnforcesServerRelationshipAndRewards(t *testing.T) {
	for _, scenario := range []string{"valid", "invalid code", "disabled inviter", "deleted inviter", "no compliance", "paused", "fixed rewards disabled", "lookup failure"} {
		t.Run(scenario, func(t *testing.T) {
			inviter := setupInvitationRegistrationController(t)
			code := inviter.AffCode
			expectedQuota, expectedReward, expectedRate, expectedInviter := 50, 40, 1000, inviter.Id
			switch scenario {
			case "invalid code":
				code = "missing-code"
				expectedQuota, expectedReward, expectedRate, expectedInviter = 20, 0, 0, 0
			case "disabled inviter":
				require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", inviter.Id).Update("status", common.UserStatusDisabled).Error)
				expectedRate = 0
			case "deleted inviter":
				require.NoError(t, model.DB.Delete(&inviter).Error)
				expectedQuota, expectedReward, expectedRate, expectedInviter = 20, 0, 0, 0
			case "no compliance":
				operation_setting.GetPaymentSetting().ComplianceConfirmed = false
				expectedQuota, expectedReward, expectedRate = 20, 0, 0
			case "paused":
				require.NoError(t, model.SaveReferralRebateRule(model.ReferralRebateRule{Enabled: false, RateBPS: 1000, ValidDays: 2}))
				expectedRate = 0
			case "fixed rewards disabled":
				common.QuotaForInvitee, common.QuotaForInviter = 0, 0
				expectedQuota, expectedReward = 20, 0
			case "lookup failure":
				require.NoError(t, model.DB.Callback().Query().Before("gorm:query").Register("registration_inviter_read_failure", func(tx *gorm.DB) {
					if len(tx.Statement.Selects) == 1 && tx.Statement.Selects[0] == "id" {
						tx.AddError(errors.New("inviter lookup unavailable"))
					}
				}))
				t.Cleanup(func() { _ = model.DB.Callback().Query().Remove("registration_inviter_read_failure") })
			}
			request, err := common.Marshal(map[string]any{
				"username": "invitee-user", "password": "test-password-12345", "aff_code": code,
				"inviter_id": 999999, "created_at": 1, "referral_rate_bps": 10000, "referral_expires_at": 9999999999,
				"aff_quota": 999999, "aff_history_quota": 999999, "quota": 999999,
			})
			require.NoError(t, err)
			router := gin.New()
			router.POST("/api/user/register", Register)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/user/register", strings.NewReader(string(request))))
			var body struct {
				Success bool `json:"success"`
			}
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &body))
			assert.Equal(t, scenario != "lookup failure", body.Success, response.Body.String())
			if scenario == "lookup failure" {
				var count int64
				require.NoError(t, model.DB.Model(&model.User{}).Where("username = ?", "invitee-user").Count(&count).Error)
				assert.Zero(t, count)
				return
			}
			var registered model.User
			require.NoError(t, model.DB.Where("username = ?", "invitee-user").First(&registered).Error)
			assert.Equal(t, expectedQuota, registered.Quota)
			assert.Equal(t, expectedInviter, registered.InviterId)
			assert.Equal(t, expectedRate, registered.ReferralRateBPS)
			assert.Zero(t, registered.AffQuota)
			assert.Zero(t, registered.AffHistoryQuota)
			assert.InDelta(t, time.Now().Unix(), registered.CreatedAt, 5)
			if expectedRate != 0 {
				assert.Equal(t, registered.CreatedAt+2*86400, registered.ReferralExpiresAt)
			} else {
				assert.Zero(t, registered.ReferralExpiresAt)
			}
			var owner model.User
			require.NoError(t, model.DB.Unscoped().First(&owner, inviter.Id).Error)
			assert.Equal(t, 100+expectedReward, owner.AffQuota)
			assert.Equal(t, 200+expectedReward, owner.AffHistoryQuota)
			response = httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/user/register", strings.NewReader(string(request))))
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &body))
			assert.False(t, body.Success, "replaying registration must not create another reward")
			require.NoError(t, model.DB.Unscoped().First(&owner, inviter.Id).Error)
			assert.Equal(t, 100+expectedReward, owner.AffQuota)
		})
	}
}

func TestInvitationOAuthRegistrationAndAssociationRollback(t *testing.T) {
	for _, providerName := range []string{"github", "discord", "oidc", "linuxdo", "custom"} {
		t.Run(providerName, func(t *testing.T) {
			inviter := setupInvitationRegistrationController(t)
			var provider oauth.Provider
			switch providerName {
			case "github":
				provider = &oauth.GitHubProvider{}
			case "discord":
				provider = &oauth.DiscordProvider{}
			case "oidc":
				provider = &oauth.OIDCProvider{}
			case "linuxdo":
				provider = &oauth.LinuxDOProvider{}
			case "custom":
				provider = oauth.NewGenericOAuthProvider(&model.CustomOAuthProvider{Id: 42, Slug: "referral-custom", Name: "Referral custom", Enabled: true})
			}
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodGet, "/api/oauth/"+providerName, nil)
			identity := &oauth.OAuthUser{ProviderUserID: "external-user-123", Username: "oauth-invitee"}
			failure := errors.New("provider association write failed")
			if providerName == "custom" {
				require.NoError(t, model.DB.Callback().Create().Before("gorm:create").Register("referral_binding_failure", func(tx *gorm.DB) {
					if tx.Statement.Table == "user_oauth_bindings" {
						tx.AddError(failure)
					}
				}))
			} else {
				require.NoError(t, model.DB.Callback().Update().Before("gorm:update").Register("referral_binding_failure", func(tx *gorm.DB) {
					if updates, ok := tx.Statement.Dest.(map[string]any); ok && updates[provider.ProviderUserIDColumn()] == identity.ProviderUserID {
						tx.AddError(failure)
					}
				}))
			}
			_, _, err := findOrCreateOAuthUser(c, provider, identity, &oauth.OAuthToken{}, inviter.AffCode)
			require.ErrorIs(t, err, failure)
			require.NoError(t, model.DB.Callback().Create().Remove("referral_binding_failure"))
			require.NoError(t, model.DB.Callback().Update().Remove("referral_binding_failure"))
			var count int64
			require.NoError(t, model.DB.Model(&model.User{}).Where("username = ?", identity.Username).Count(&count).Error)
			assert.Zero(t, count)
			var owner model.User
			require.NoError(t, model.DB.First(&owner, inviter.Id).Error)
			assert.Equal(t, 100, owner.AffQuota)
			assert.Equal(t, 200, owner.AffHistoryQuota)

			created, _, err := findOrCreateOAuthUser(c, provider, identity, &oauth.OAuthToken{}, inviter.AffCode)
			require.NoError(t, err)
			assert.Equal(t, inviter.Id, created.InviterId)
			assert.Equal(t, 50, created.Quota)
			assert.Equal(t, 1000, created.ReferralRateBPS)
			assert.Equal(t, created.CreatedAt+2*86400, created.ReferralExpiresAt)
			repeated, _, err := findOrCreateOAuthUser(c, provider, identity, &oauth.OAuthToken{}, "different-code")
			require.NoError(t, err)
			assert.Equal(t, created.Id, repeated.Id)
			assert.Equal(t, inviter.Id, repeated.InviterId)
			assert.Equal(t, created.ReferralExpiresAt, repeated.ReferralExpiresAt)
			require.NoError(t, model.DB.First(&owner, inviter.Id).Error)
			assert.Equal(t, 140, owner.AffQuota)
			assert.Equal(t, 240, owner.AffHistoryQuota)
		})
	}
}

func TestInvitationOAuthLookupFailureDoesNotCreateAccountOrRewards(t *testing.T) {
	for _, provider := range []oauth.Provider{
		&oauth.GitHubProvider{}, &oauth.DiscordProvider{}, &oauth.OIDCProvider{}, &oauth.LinuxDOProvider{},
		oauth.NewGenericOAuthProvider(&model.CustomOAuthProvider{Id: 42, Slug: "referral-custom", Name: "Referral custom", Enabled: true}),
	} {
		t.Run(provider.GetName(), func(t *testing.T) {
			inviter := setupInvitationRegistrationController(t)
			existing := model.User{Username: "existing-oauth", AffCode: "existing-oauth-code", Status: common.UserStatusEnabled}
			const subject = "existing-provider-id"
			provider.SetProviderUserID(&existing, subject)
			require.NoError(t, model.DB.Create(&existing).Error)
			table, column := "users", provider.ProviderUserIDColumn()
			if custom, ok := provider.(*oauth.GenericOAuthProvider); ok {
				require.NoError(t, model.DB.Create(&model.UserOAuthBinding{UserId: existing.Id, ProviderId: custom.GetProviderId(), ProviderUserId: subject}).Error)
				table, column = "user_oauth_bindings", "provider_user_id"
			}
			failure := errors.New("OAuth identity lookup unavailable")
			failed := false
			require.NoError(t, model.DB.Callback().Query().Before("gorm:query").Register("referral_identity_read_failure", func(tx *gorm.DB) {
				if !failed && tx.Statement.Table == table && strings.Contains(fmt.Sprint(tx.Statement.Clauses["WHERE"]), column) {
					failed = true
					tx.AddError(failure)
				}
			}))
			t.Cleanup(func() { _ = model.DB.Callback().Query().Remove("referral_identity_read_failure") })
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodGet, "/api/oauth/test", nil)
			_, _, err := findOrCreateOAuthUser(c, provider, &oauth.OAuthUser{ProviderUserID: subject, Username: "duplicate-oauth"}, &oauth.OAuthToken{}, inviter.AffCode)
			require.True(t, failed, "the provider identity read must reach the database fault")
			assert.ErrorIs(t, err, failure)
			var count int64
			require.NoError(t, model.DB.Model(&model.User{}).Where("username = ?", "duplicate-oauth").Count(&count).Error)
			assert.Zero(t, count)
			var owner model.User
			require.NoError(t, model.DB.First(&owner, inviter.Id).Error)
			assert.Equal(t, 100, owner.AffQuota)
			assert.Equal(t, 200, owner.AffHistoryQuota)
		})
	}
}

func TestInvitationOAuthConcurrentRegistrationDoesNotDuplicateRewards(t *testing.T) {
	for _, provider := range []oauth.Provider{&oauth.GitHubProvider{}, &oauth.DiscordProvider{}, &oauth.OIDCProvider{}, &oauth.LinuxDOProvider{}} {
		t.Run(provider.GetName(), func(t *testing.T) {
			inviter := setupInvitationRegistrationController(t)
			sqlDB, err := model.DB.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(4)
			if common.UsingMainDatabase(common.DatabaseTypeMySQL) {
				var isolation string
				require.NoError(t, model.DB.Raw("SELECT @@session.tx_isolation").Scan(&isolation).Error)
				t.Logf("MySQL session default isolation: %s", isolation)
			} else if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
				var isolation string
				require.NoError(t, model.DB.Raw("SHOW default_transaction_isolation").Scan(&isolation).Error)
				t.Logf("PostgreSQL session default isolation: %s", isolation)
			}
			locked, competing, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
			var lockReads, lockAttempts atomic.Int32
			var releaseOnce sync.Once
			t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
			// The first transaction has read the missing identity under its lock.
			// Keep it open until another connection attempts the same identity.
			require.NoError(t, model.DB.Callback().Query().After("gorm:query").Register("invitation_identity_lock_held", func(tx *gorm.DB) {
				if _, ok := tx.Statement.Dest.(*[]model.User); ok && tx.Statement.Table == "users" && strings.Contains(fmt.Sprint(tx.Statement.Clauses["WHERE"]), provider.ProviderUserIDColumn()) {
					if lockReads.Add(1) == 1 {
						close(locked)
						<-release
					}
				}
			}))
			require.NoError(t, model.DB.Callback().Query().Before("gorm:query").Register("invitation_identity_lock_attempt", func(tx *gorm.DB) {
				if common.UsingMainDatabase(common.DatabaseTypePostgreSQL) {
					return
				}
				if _, ok := tx.Statement.Dest.(*[]model.User); ok && tx.Statement.Table == "users" && strings.Contains(fmt.Sprint(tx.Statement.Clauses["WHERE"]), provider.ProviderUserIDColumn()) && lockAttempts.Add(1) == 2 {
					close(competing)
				}
			}))
			require.NoError(t, model.DB.Callback().Raw().Before("gorm:raw").Register("invitation_identity_advisory_attempt", func(tx *gorm.DB) {
				if strings.Contains(tx.Statement.SQL.String(), "pg_advisory_xact_lock") && lockAttempts.Add(1) == 2 {
					close(competing)
				}
			}))
			t.Cleanup(func() {
				_ = model.DB.Callback().Query().Remove("invitation_identity_lock_held")
				_ = model.DB.Callback().Query().Remove("invitation_identity_lock_attempt")
				_ = model.DB.Callback().Raw().Remove("invitation_identity_advisory_attempt")
			})
			register := func(username string) error {
				c, _ := gin.CreateTestContext(httptest.NewRecorder())
				c.Request = httptest.NewRequest(http.MethodGet, "/api/oauth/test", nil)
				_, _, err := findOrCreateOAuthUser(c, provider, &oauth.OAuthUser{ProviderUserID: "shared-provider-subject", Username: username}, &oauth.OAuthToken{}, inviter.AffCode)
				return err
			}
			first, second := make(chan error, 1), make(chan error, 1)
			go func() { first <- register("first-registration") }()
			<-locked
			go func() { second <- register("second-registration") }()
			<-competing
			releaseOnce.Do(func() { close(release) })
			firstErr, secondErr := <-first, <-second
			require.True(t, firstErr == nil || secondErr == nil, "at least one registration must commit: first=%v, second=%v", firstErr, secondErr)
			// A serialization/deadlock loser may retry, but can only return the
			// original account; it cannot repeat qualification or fixed rewards.
			require.NoError(t, register("retried-registration"))
			var users []model.User
			require.NoError(t, model.DB.Where(map[string]any{provider.ProviderUserIDColumn(): "shared-provider-subject"}).Find(&users).Error)
			require.Len(t, users, 1)
			assert.Equal(t, inviter.Id, users[0].InviterId)
			assert.Equal(t, 1000, users[0].ReferralRateBPS)
			var owner model.User
			require.NoError(t, model.DB.First(&owner, inviter.Id).Error)
			assert.Equal(t, 140, owner.AffQuota)
			assert.Equal(t, 240, owner.AffHistoryQuota)
			assert.GreaterOrEqual(t, sqlDB.Stats().OpenConnections, 2, "concurrency must use independent database connections")
		})
	}
}

func TestInvitationOAuthConcurrentIdentityBindingDoesNotCreateEligibility(t *testing.T) {
	for _, operation := range []string{"binding", "legacy migration"} {
		t.Run(operation, func(t *testing.T) {
			inviter := setupInvitationRegistrationController(t)
			account := model.User{Username: "existing-account", AffCode: "existing-account-code", Status: common.UserStatusEnabled, AuthVersion: 1}
			if operation == "legacy migration" {
				account.GitHubId = "legacy-login"
			}
			require.NoError(t, model.DB.Create(&account).Error)
			session := model.UserSession{SID: "identity-binding-session", UserID: account.Id, UserAuthVersion: 1, Version: 1, Status: model.UserSessionStatusActive, ExpiresAt: time.Now().Add(time.Hour).Unix()}
			require.NoError(t, model.DB.Create(&session).Error)
			paused, release := make(chan struct{}), make(chan struct{})
			var intercepted atomic.Bool
			require.NoError(t, model.DB.Callback().Query().After("gorm:query").Register("invitation_stale_identity_lookup", func(tx *gorm.DB) {
				if tx.Statement.Table == "users" && strings.Contains(fmt.Sprint(tx.Statement.Clauses["WHERE"]), "github_id") && errors.Is(tx.Error, gorm.ErrRecordNotFound) && intercepted.CompareAndSwap(false, true) {
					close(paused)
					<-release
				}
			}))
			t.Cleanup(func() { _ = model.DB.Callback().Query().Remove("invitation_stale_identity_lookup") })
			type registrationResult struct {
				user *model.User
				err  error
			}
			result := make(chan registrationResult, 1)
			go func() {
				c, _ := gin.CreateTestContext(httptest.NewRecorder())
				c.Request = httptest.NewRequest(http.MethodGet, "/api/oauth/github", nil)
				user, _, err := findOrCreateOAuthUser(c, &oauth.GitHubProvider{}, &oauth.OAuthUser{ProviderUserID: "new-provider-subject", Username: "duplicate-identity"}, &oauth.OAuthToken{}, inviter.AffCode)
				result <- registrationResult{user, err}
			}()
			<-paused
			err := model.DB.Transaction(func(tx *gorm.DB) error {
				if operation == "legacy migration" {
					written, err := model.MigrateLegacyGitHubBindingWithTx(tx, account.Id, "legacy-login", "new-provider-subject")
					assert.True(t, written)
					return err
				}
				return model.UpdateUserBindColumnForSessionWithTx(tx, model.AuthSessionIdentity{UserID: account.Id, SessionID: session.SID, UserAuthVersion: 1, SessionVersion: 1}, "github_id", "new-provider-subject")
			}, model.OAuthIdentityTransactionOptions("github_id"))
			close(release)
			require.NoError(t, err)
			registered := <-result
			require.NoError(t, registered.err)
			require.NotNil(t, registered.user)
			assert.Equal(t, account.Id, registered.user.Id)
			assert.Zero(t, registered.user.InviterId)
			assert.Zero(t, registered.user.ReferralRateBPS)
			var count int64
			require.NoError(t, model.DB.Model(&model.User{}).Where("github_id = ?", "new-provider-subject").Count(&count).Error)
			assert.EqualValues(t, 1, count)
			var owner model.User
			require.NoError(t, model.DB.First(&owner, inviter.Id).Error)
			assert.Equal(t, 100, owner.AffQuota)
			assert.Equal(t, 200, owner.AffHistoryQuota)
		})
	}
}

func TestInvitationTransferControllerRequestIdentityAndResultIsolation(t *testing.T) {
	inviter := setupInvitationRegistrationController(t)
	previousUnit := common.QuotaPerUnit
	common.QuotaPerUnit = 10
	t.Cleanup(func() { common.QuotaPerUnit = previousUnit })
	router := gin.New()
	router.Use(func(c *gin.Context) { c.Set("id", inviter.Id) })
	router.POST("/api/user/aff_transfer", TransferAffQuota)
	router.GET("/api/user/aff_transfer/:request_id", GetAffTransfer)
	for _, body := range []string{
		`{"quota":25,"request_id":"controller-transfer-01"}`,
		`{"quota":25,"request_id":"controller-transfer-01"}`,
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/user/aff_transfer", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(response, request)
		var result struct {
			Success bool `json:"success"`
		}
		require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
		require.True(t, result.Success, response.Body.String())
	}
	var owner model.User
	require.NoError(t, model.DB.First(&owner, inviter.Id).Error)
	assert.Equal(t, 25, owner.Quota)
	assert.Equal(t, 75, owner.AffQuota)
	assert.Equal(t, 200, owner.AffHistoryQuota)
	operation_setting.GetPaymentSetting().ComplianceConfirmed = false
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/user/aff_transfer/controller-transfer-01", nil))
	var result struct {
		Success bool `json:"success"`
		Data    struct {
			Found bool `json:"found"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
	assert.True(t, result.Success)
	assert.True(t, result.Data.Found, "compliance pause does not prevent result verification")
	for _, amount := range []int{25, 30} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/user/aff_transfer", strings.NewReader(fmt.Sprintf("{\"quota\":%d,\"request_id\":\"controller-transfer-01\"}", amount)))
		request.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(response, request)
		var repeated map[string]any
		require.NoError(t, common.Unmarshal(response.Body.Bytes(), &repeated))
		assert.Equal(t, amount == 25, repeated["success"])
		if amount != 25 {
			assert.Nil(t, repeated["data"], "a mismatched committed identity cannot be classified as a new rejected transfer")
		}
	}
	inviter.Id++
	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/user/aff_transfer/controller-transfer-01", nil))
	require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
	assert.True(t, result.Success)
	assert.False(t, result.Data.Found)
}

func TestInvitationTransferDefiniteRejections(t *testing.T) {
	for _, kind := range []string{"invalid quota", "minimum", "insufficient", "wallet capacity", "compliance paused", "disabled", "existing amount mismatch", "record write failure", "rejection record write failure", "legacy request without ID"} {
		t.Run(kind, func(t *testing.T) {
			inviter := setupInvitationRegistrationController(t)
			previousUnit := common.QuotaPerUnit
			common.QuotaPerUnit = 10
			t.Cleanup(func() { common.QuotaPerUnit = previousUnit })
			quota, expectedWallet, expectedReward, expectedFacts := 25, 0, 100, int64(0)
			rejected := true
			switch kind {
			case "legacy request without ID":
				rejected = false
			case "invalid quota":
				quota = -1
			case "minimum":
				quota = 5
			case "insufficient":
				quota = 101
			case "wallet capacity":
				expectedWallet = common.MaxWalletQuota - 5
				require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", inviter.Id).Update("quota", expectedWallet).Error)
			case "compliance paused":
				operation_setting.GetPaymentSetting().ComplianceConfirmed = false
			case "disabled":
				require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", inviter.Id).Update("status", common.UserStatusDisabled).Error)
			case "existing amount mismatch":
				_, err := inviter.TransferAffQuotaToQuota(25, "readiness-rejection-01")
				require.NoError(t, err)
				quota, expectedWallet, expectedReward, expectedFacts, rejected = 30, 25, 75, 1, false
			case "record write failure", "rejection record write failure":
				rejected = false
				if kind == "rejection record write failure" {
					quota = 101
				}
				require.NoError(t, model.DB.Callback().Create().Before("gorm:create").Register("readiness:transfer-write-failure", func(tx *gorm.DB) {
					if tx.Statement.Table == "affiliate_transfers" {
						tx.AddError(errors.New("isolated transfer record write failure"))
					}
				}))
				t.Cleanup(func() { require.NoError(t, model.DB.Callback().Create().Remove("readiness:transfer-write-failure")) })
			}
			router := gin.New()
			router.Use(func(c *gin.Context) { c.Set("id", inviter.Id) })
			router.POST("/api/user/aff_transfer", TransferAffQuota)
			router.GET("/api/user/aff_transfer/:request_id", GetAffTransfer)
			response := httptest.NewRecorder()
			body := fmt.Sprintf("{\"quota\":%d,\"request_id\":\"readiness-rejection-01\"}", quota)
			if kind == "legacy request without ID" {
				body = "{\"quota\":25}"
			}
			request := httptest.NewRequest(http.MethodPost, "/api/user/aff_transfer", strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(response, request)
			var result map[string]any
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
			assert.Equal(t, http.StatusOK, response.Code)
			assert.Equal(t, false, result["success"], response.Body.String())
			if rejected {
				assert.Equal(t, map[string]any{"transfer_status": "rejected", "request_id": "readiness-rejection-01", "quota": float64(quota), "result_persisted": true}, result["data"])
				expectedFacts++
				lookup := httptest.NewRecorder()
				router.ServeHTTP(lookup, httptest.NewRequest(http.MethodGet, "/api/user/aff_transfer/readiness-rejection-01", nil))
				var verified struct {
					Success bool `json:"success"`
					Data    struct {
						Found     bool                     `json:"found"`
						Transfer  *model.AffiliateTransfer `json:"transfer"`
						Rejection map[string]any           `json:"rejection"`
					} `json:"data"`
				}
				require.NoError(t, common.Unmarshal(lookup.Body.Bytes(), &verified))
				assert.True(t, verified.Success)
				assert.False(t, verified.Data.Found, "old clients must not interpret rejection as credit")
				assert.Nil(t, verified.Data.Transfer)
				assert.Equal(t, "readiness-rejection-01", verified.Data.Rejection["request_id"])
				assert.Equal(t, float64(quota), verified.Data.Rejection["quota"])
				assert.Equal(t, result["message_key"], verified.Data.Rejection["message_key"])
				assert.Equal(t, result["message_params"], verified.Data.Rejection["message_params"])
			} else {
				assert.Nil(t, result["data"], "technical failures or an existing different operation must remain unresolved")
			}
			var current model.User
			require.NoError(t, model.DB.First(&current, inviter.Id).Error)
			assert.Equal(t, expectedWallet, current.Quota)
			assert.Equal(t, expectedReward, current.AffQuota)
			assert.Equal(t, 200, current.AffHistoryQuota)
			var count int64
			require.NoError(t, model.DB.Model(&model.AffiliateTransfer{}).Count(&count).Error)
			assert.Equal(t, expectedFacts, count)
		})
	}
}

func TestGetAffCodeDoesNotRestoreConcurrentSecurityChanges(t *testing.T) {
	for _, action := range []string{"root_password_change", "disable", "demote"} {
		t.Run(action, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			previousMaster := common.IsMasterNode
			common.IsMasterNode = false
			t.Cleanup(func() { common.IsMasterNode = previousMaster })
			require.NoError(t, authz.Init(db))
			const oldPassword = "Audit13-old-password!"
			const newPassword = "Audit13-new-password!"
			hash, err := common.HashAccountPassword(oldPassword)
			require.NoError(t, err)
			role := common.RoleCommonUser
			if action == "root_password_change" {
				role = common.RoleRootUser
			}
			if action == "demote" {
				role = common.RoleAdminUser
			}
			user := model.User{Username: "aff-race-" + action, Password: hash, Role: role, Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1, Quota: 700, AffQuota: 300, AffHistoryQuota: 400}
			require.NoError(t, db.Create(&user).Error)
			require.Empty(t, user.AffCode)
			bundle, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "audit13-aff-code")
			require.NoError(t, err)
			identity, err := service.ParseAccessToken(bundle.AccessToken)
			require.NoError(t, err)
			var adminIdentity service.AuthIdentity
			var proof string
			if action != "root_password_change" {
				adminIdentity, proof = manageUserProof(t, db, service.VerificationOperation{Scope: service.VerificationScopeAdminUserManage, Context: []byte(fmt.Sprintf("{\"user_id\":%d,\"action\":%q}", user.Id, action))})
			}
			readDone, release := make(chan struct{}), make(chan struct{})
			var blocked, handlerEntered atomic.Bool
			var workers sync.WaitGroup
			const callbackName = "audit13:block_affiliate_full_user_read"
			require.NoError(t, db.Callback().Query().After("gorm:query").Register(callbackName, func(tx *gorm.DB) {
				snapshot, ok := tx.Statement.Dest.(*model.User)
				if ok && tx.Statement.Table == "users" && snapshot.Id == user.Id && handlerEntered.Load() && snapshot.AffCode == "" && blocked.CompareAndSwap(false, true) {
					close(readDone)
					<-release
				}
			}))
			released := false
			t.Cleanup(func() {
				if !released {
					close(release)
				}
				workers.Wait()
				assert.NoError(t, db.Callback().Query().Remove(callbackName))
			})
			router := gin.New()
			router.Use(middleware.RequestId())
			router.GET("/api/user/aff", middleware.UserAuth(), func(c *gin.Context) { handlerEntered.Store(true); c.Next() }, GetAffCode)
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/user/aff", nil)
			request.Header.Set("Authorization", "Bearer "+bundle.AccessToken)
			finished := make(chan struct{})
			workers.Go(func() { router.ServeHTTP(response, request); close(finished) })
			select {
			case <-readDone:
			case <-finished:
				t.Fatalf("request never reached invitation read: HTTP%d %s", response.Code, response.Body.String())
			case <-time.After(5 * time.Second):
				t.Fatal("invitation read barrier was not reached")
			}
			if action == "root_password_change" {
				update := model.User{Id: user.Id, Password: newPassword, OriginalPassword: oldPassword}
				require.NoError(t, model.ChangeUserPassword(identity, &update, false))
				require.True(t, common.ValidatePasswordAndHash(newPassword, update.Password))
			} else {
				changed := performVerifiedManageUserRequest(t, fmt.Sprintf("{\"id\":%d,\"action\":%q}", user.Id, action), adminIdentity, proof)
				require.Equal(t, http.StatusOK, changed.Code)
				require.Contains(t, changed.Body.String(), "\"success\":true")
			}
			var restricted model.User
			require.NoError(t, db.First(&restricted, user.Id).Error)
			if action == "disable" {
				require.Equal(t, common.UserStatusDisabled, restricted.Status)
			}
			if action == "demote" {
				require.Equal(t, common.RoleCommonUser, restricted.Role)
			}
			require.EqualValues(t, 2, restricted.AuthVersion)
			close(release)
			released = true
			select {
			case <-finished:
			case <-time.After(5 * time.Second):
				t.Fatal("invitation request did not complete")
			}
			require.Equal(t, http.StatusOK, response.Code)
			require.Contains(t, response.Body.String(), "\"success\":true")
			var actual model.User
			require.NoError(t, db.First(&actual, user.Id).Error)
			require.NotEmpty(t, actual.AffCode)
			assert.Equal(t, restricted.Status, actual.Status, "invitation code generation must preserve the newer account status")
			assert.Equal(t, restricted.Role, actual.Role, "invitation code generation must preserve the newer account role")
			assert.Equal(t, restricted.AuthVersion, actual.AuthVersion, "invitation code generation must not mutate authentication version")
			assert.Equal(t, 700, actual.Quota)
			assert.Equal(t, 300, actual.AffQuota)
			assert.Equal(t, 400, actual.AffHistoryQuota)
			if action == "root_password_change" {
				assert.True(t, common.ValidatePasswordAndHash(newPassword, actual.Password), "the newly changed password must remain usable")
				assert.False(t, common.ValidatePasswordAndHash(oldPassword, actual.Password), "the previous password must remain revoked")
				oldLogin := model.User{Username: user.Username, Password: oldPassword}
				newLogin := model.User{Username: user.Username, Password: newPassword}
				assert.Error(t, oldLogin.ValidateAndFill(), "the real password validation path must reject old credentials")
				assert.NoError(t, newLogin.ValidateAndFill(), "the real password validation path must accept the new credential")
			}
			t.Logf("UserAuth + GET /api/user/aff crossed %s: status %d->%d role %d->%d authVersion %d->%d; funds unchanged", action, restricted.Status, actual.Status, restricted.Role, actual.Role, restricted.AuthVersion, actual.AuthVersion)
		})
	}
}

func TestGetAffCodeConcurrentFirstRequestsPreserveUser(t *testing.T) {
	for _, initial := range []string{"empty", "null"} {
		t.Run(initial, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			sqlDB.SetMaxOpenConns(4)
			user := model.User{Username: "first-aff-" + initial, Password: "unchanged-password-hash", Role: common.RoleAdminUser, Status: common.UserStatusEnabled, Group: "default", AuthVersion: 7, Quota: 700, UsedQuota: 30, RequestCount: 2, AffQuota: 300, AffHistoryQuota: 400, AffCount: 4, InviterId: 88, ReferralRateBPS: 1250, ReferralExpiresAt: 2000000000, Email: "aff@example.test", GitHubId: "existing-binding", Setting: "{\"language\":\"en\"}"}
			require.NoError(t, db.Create(&user).Error)
			if initial == "null" {
				require.NoError(t, db.Model(&model.User{}).Where("id = ?", user.Id).UpdateColumn("aff_code", nil).Error)
			}
			bundle, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "affiliate-concurrency")
			require.NoError(t, err)
			var before model.User
			require.NoError(t, db.First(&before, user.Id).Error)
			ready, release := make(chan struct{}), make(chan struct{})
			var arrived atomic.Int32
			var releaseOnce sync.Once
			var workers sync.WaitGroup
			const callbackName = "test:hold_first_affiliate_code_updates"
			require.NoError(t, db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
				if tx.Statement.Table != "users" {
					return
				}
				changes, ok := tx.Statement.Dest.(map[string]any)
				if !ok {
					return
				}
				if _, ok = changes["aff_code"]; !ok {
					return
				}
				if arrived.Add(1) == 2 {
					close(ready)
				}
				<-release
			}))
			t.Cleanup(func() {
				releaseOnce.Do(func() { close(release) })
				workers.Wait()
				assert.NoError(t, db.Callback().Update().Remove(callbackName))
			})
			router := gin.New()
			router.Use(middleware.RequestId())
			router.GET("/api/user/aff", middleware.UserAuth(), GetAffCode)
			responses := make(chan *httptest.ResponseRecorder, 2)
			for range 2 {
				workers.Go(func() {
					response := httptest.NewRecorder()
					request := httptest.NewRequest(http.MethodGet, "/api/user/aff", nil)
					request.Header.Set("Authorization", "Bearer "+bundle.AccessToken)
					router.ServeHTTP(response, request)
					responses <- response
				})
			}
			select {
			case <-ready:
			case <-time.After(5 * time.Second):
				t.Fatal("two authenticated requests did not both reach their first code write")
			}
			require.GreaterOrEqual(t, sqlDB.Stats().InUse, 2, "competing writes must hold independent database connections")
			t.Logf("competing invitation writes hold %d database connections", sqlDB.Stats().InUse)
			releaseOnce.Do(func() { close(release) })
			var codes []string
			for range 2 {
				select {
				case response := <-responses:
					require.Equal(t, http.StatusOK, response.Code)
					var body struct {
						Success bool
						Data    string
					}
					require.NoError(t, common.Unmarshal(response.Body.Bytes(), &body))
					require.True(t, body.Success, response.Body.String())
					require.Len(t, body.Data, 4)
					codes = append(codes, body.Data)
				case <-time.After(5 * time.Second):
					t.Fatal("concurrent invitation request did not finish")
				}
			}
			require.Equal(t, codes[0], codes[1], "first callers must receive the same persisted invitation code")
			var after model.User
			require.NoError(t, db.First(&after, user.Id).Error)
			before.AffCode = codes[0]
			assert.Equal(t, before, after, "invitation code creation must not alter credentials, privileges, balances, bindings or referral qualification")
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/user/aff", nil)
			request.Header.Set("Authorization", "Bearer "+bundle.AccessToken)
			router.ServeHTTP(response, request)
			assert.Contains(t, response.Body.String(), fmt.Sprintf("\"data\":%q", codes[0]))
		})
	}
}

func TestGetAffCodePropagatesDatabaseFailures(t *testing.T) {
	for _, failure := range []string{"read", "write"} {
		t.Run(failure, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			user := model.User{Username: "failed-aff-" + failure, Password: "unchanged-password-hash", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AuthVersion: 1}
			require.NoError(t, db.Create(&user).Error)
			bundle, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "affiliate-failure")
			require.NoError(t, err)
			var inHandler atomic.Bool
			injected := errors.New("injected invitation database failure")
			const callbackName = "test:reject_affiliate_database_operation"
			reject := func(tx *gorm.DB) {
				if inHandler.Load() && tx.Statement.Table == "users" {
					tx.AddError(injected)
				}
			}
			if failure == "read" {
				require.NoError(t, db.Callback().Query().Before("gorm:query").Register(callbackName, reject))
				t.Cleanup(func() { assert.NoError(t, db.Callback().Query().Remove(callbackName)) })
			} else {
				require.NoError(t, db.Callback().Update().Before("gorm:update").Register(callbackName, reject))
				t.Cleanup(func() { assert.NoError(t, db.Callback().Update().Remove(callbackName)) })
			}
			router := gin.New()
			router.Use(middleware.RequestId())
			router.GET("/api/user/aff", middleware.UserAuth(), func(c *gin.Context) { inHandler.Store(true); c.Next() }, GetAffCode)
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/user/aff", nil)
			request.Header.Set("Authorization", "Bearer "+bundle.AccessToken)
			router.ServeHTTP(response, request)
			inHandler.Store(false)
			require.Equal(t, http.StatusOK, response.Code)
			assert.Contains(t, response.Body.String(), "\"success\":false")
			var after model.User
			require.NoError(t, db.First(&after, user.Id).Error)
			assert.Empty(t, after.AffCode)
			assert.Equal(t, user.AuthVersion, after.AuthVersion)
		})
	}
}
