package model

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	sqlmysql "github.com/go-sql-driver/mysql"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type MigrationIdentityFields struct {
	ID        int    `gorm:"primaryKey"`
	Name      string `gorm:"size:64;unique"`
	Reference string `gorm:"size:64;uniqueIndex"`
	Provider  string `gorm:"size:32;uniqueIndex:,composite:provider_subject"`
	Subject   string `gorm:"size:64;uniqueIndex:,composite:provider_subject"`
}

type migrationIdentityV1 struct {
	MigrationIdentityFields
	Digest string `gorm:"type:char(32)"`
}

type migrationIdentityV2 struct {
	MigrationIdentityFields
	Digest string `gorm:"type:char(64)"`
	Note   string `gorm:"size:128"`
}

type migrationConstraintV1 struct {
	ID   int    `gorm:"primaryKey"`
	Name string `gorm:"size:64"`
}

type migrationConstraintV2 struct {
	ID   int    `gorm:"primaryKey"`
	Name string `gorm:"size:64;unique"`
}

type migrationDecimalV1 struct {
	ID    int     `gorm:"primaryKey"`
	Price float64 `gorm:"type:decimal(10,6);default:0"`
}

type migrationDecimalV2 struct {
	ID    int     `gorm:"primaryKey"`
	Price float64 `gorm:"type:decimal(12,6);not null;default:0"`
}

type migrationDecimalV3 struct {
	ID    int     `gorm:"primaryKey"`
	Price float64 `gorm:"type:decimal(12,6);not null;default:1.25"`
}

func TestMigrationSchemaStability(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			var dsn string
			switch dialect {
			case "sqlite":
				dsn = "local"
				previousPath := common.SQLitePath
				common.SQLitePath = filepath.Join(t.TempDir(), "migration.db")
				t.Cleanup(func() { common.SQLitePath = previousPath })
			case "mysql":
				dsn = os.Getenv("TEST_MYSQL_DSN")
			case "postgres":
				dsn = os.Getenv("TEST_POSTGRES_DSN")
			}
			if dsn == "" {
				t.Skip("test database DSN is not configured")
			}
			t.Setenv("MIGRATION_TEST_DSN", dsn)
			db, _, err := chooseDB("MIGRATION_TEST_DSN", false)
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			t.Cleanup(func() { _ = sqlDB.Close() })
			recorder := &migrationSQLRecorder{}
			db = db.Session(&gorm.Session{Logger: recorder})

			t.Run("identity_and_indexes", func(t *testing.T) {
				const table = "migration_identity_test"
				t.Cleanup(func() { _ = db.Migrator().DropTable(table) })
				require.NoError(t, db.Table(table).AutoMigrate(&migrationIdentityV1{}))
				row := migrationIdentityV1{
					MigrationIdentityFields: MigrationIdentityFields{ID: 1, Name: "root", Reference: "token-reference", Provider: "oidc", Subject: "subject"},
					Digest:                  "old-digest",
				}
				require.NoError(t, db.Table(table).Create(&row).Error)
				recorder.reset()
				require.NoError(t, db.Table(table).AutoMigrate(&migrationIdentityV1{}))
				assert.Empty(t, recorder.schemaMutations())

				require.NoError(t, db.Table(table).AutoMigrate(&migrationIdentityV2{}))
				columns, err := db.Table(table).Migrator().ColumnTypes(&migrationIdentityV2{})
				require.NoError(t, err)
				for _, column := range columns {
					if column.Name() == "digest" {
						length, ok := column.Length()
						require.True(t, ok)
						assert.EqualValues(t, 64, length)
					}
				}
				assert.True(t, db.Table(table).Migrator().HasColumn(&migrationIdentityV2{}, "note"))
				recorder.reset()
				require.NoError(t, db.Table(table).AutoMigrate(&migrationIdentityV2{}))
				assert.Empty(t, recorder.schemaMutations())
				var saved migrationIdentityV2
				require.NoError(t, db.Table(table).First(&saved, 1).Error)
				assert.Equal(t, row.MigrationIdentityFields, saved.MigrationIdentityFields)
				expectedDigest := row.Digest
				if dialect == "postgres" {
					expectedDigest += strings.Repeat(" ", 64-len(row.Digest))
				}
				assert.Equal(t, expectedDigest, saved.Digest)
				for _, duplicate := range []migrationIdentityV2{
					{MigrationIdentityFields: MigrationIdentityFields{Name: "root", Reference: "other-1", Provider: "other", Subject: "1"}},
					{MigrationIdentityFields: MigrationIdentityFields{Name: "other-2", Reference: "token-reference", Provider: "other", Subject: "2"}},
					{MigrationIdentityFields: MigrationIdentityFields{Name: "other-3", Reference: "other-3", Provider: "oidc", Subject: "subject"}},
				} {
					assert.Error(t, db.Table(table).Create(&duplicate).Error)
				}
			})

			t.Run("unique_constraint_changes", func(t *testing.T) {
				const table = "migration_constraint_test"
				t.Cleanup(func() { _ = db.Migrator().DropTable(table) })
				require.NoError(t, db.Table(table).AutoMigrate(&migrationConstraintV1{}))
				require.NoError(t, db.Table(table).Create(&migrationConstraintV1{Name: "existing"}).Error)
				require.NoError(t, db.Table(table).AutoMigrate(&migrationConstraintV2{}))
				assert.Error(t, db.Table(table).Create(&migrationConstraintV2{Name: "existing"}).Error)
				recorder.reset()
				require.NoError(t, db.Table(table).AutoMigrate(&migrationConstraintV2{}))
				assert.Empty(t, recorder.schemaMutations())
				require.NoError(t, db.Table(table).AutoMigrate(&migrationConstraintV1{}))
				require.NoError(t, db.Table(table).Create(&migrationConstraintV1{Name: "existing"}).Error)
			})

			if dialect == "postgres" {
				t.Run("renamed_unique_constraints", func(t *testing.T) {
					const table = "migration_renamed_unique"
					t.Cleanup(func() { _ = db.Migrator().DropTable(table) })
					tableDB := db.Table(table).Session(&gorm.Session{})
					require.NoError(t, tableDB.AutoMigrate(&migrationConstraintV1{}))
					original := migrationConstraintV1{Name: "existing"}
					require.NoError(t, tableDB.Create(&original).Error)
					for _, name := range []string{"models_model_name_key", `imported "model" name`} {
						require.NoError(t, db.Exec("ALTER TABLE ? ADD CONSTRAINT ? UNIQUE (name)", clause.Table{Name: table}, clause.Column{Name: name}).Error)
					}
					require.NoError(t, db.Exec("ALTER TABLE ? ADD CONSTRAINT keep_composite UNIQUE (id, name)", clause.Table{Name: table}).Error)
					require.NoError(t, db.Exec("CREATE INDEX keep_name_lookup ON ? (name)", clause.Table{Name: table}).Error)
					// A unique field must keep the old names and still reject duplicates.
					require.NoError(t, tableDB.AutoMigrate(&migrationConstraintV2{}))
					require.Error(t, tableDB.Create(&migrationConstraintV2{Name: "existing"}).Error)
					require.NoError(t, db.Exec("CREATE TABLE migration_unique_reference (name varchar(64) REFERENCES migration_renamed_unique(name))").Error)
					t.Cleanup(func() { _ = db.Migrator().DropTable("migration_unique_reference") })
					require.NoError(t, db.Exec("INSERT INTO migration_unique_reference (name) VALUES (?)", "existing").Error)
					require.Error(t, tableDB.AutoMigrate(&migrationConstraintV1{}), "dependent foreign keys must not be cascaded away")
					for _, name := range []string{"models_model_name_key", `imported "model" name`} {
						assert.True(t, tableDB.Migrator().HasConstraint(&migrationConstraintV1{}, name), "all old constraints must survive rollback")
					}
					var references int64
					require.NoError(t, db.Table("migration_unique_reference").Count(&references).Error)
					assert.EqualValues(t, 1, references)
					require.NoError(t, db.Migrator().DropTable("migration_unique_reference"))
					// Removing column uniqueness must resolve both actual constraint names.
					require.NoError(t, tableDB.AutoMigrate(&migrationConstraintV1{}))
					recorder.reset()
					require.NoError(t, tableDB.AutoMigrate(&migrationConstraintV1{}))
					assert.Empty(t, recorder.schemaMutations())
					require.NoError(t, tableDB.Create(&migrationConstraintV1{Name: "existing"}).Error)
					assert.True(t, tableDB.Migrator().HasConstraint(&migrationConstraintV1{}, "keep_composite"))
					assert.True(t, tableDB.Migrator().HasIndex(&migrationConstraintV1{}, "keep_name_lookup"))
					var rows []migrationConstraintV1
					require.NoError(t, tableDB.Order("id").Find(&rows).Error)
					require.Len(t, rows, 2)
					assert.Equal(t, original, rows[0])
				})
			}

			if dialect == "mysql" {
				t.Run("decimal_default_and_real_changes", func(t *testing.T) {
					const table = "migration_decimal_test"
					t.Cleanup(func() { _ = db.Migrator().DropTable(table) })
					require.NoError(t, db.Table(table).AutoMigrate(&migrationDecimalV1{}))
					require.NoError(t, db.Table(table).Create(&migrationDecimalV1{ID: 1, Price: 12.345678}).Error)
					for _, target := range []any{&migrationDecimalV1{}, &migrationDecimalV2{}, &migrationDecimalV3{}} {
						require.NoError(t, db.Table(table).AutoMigrate(target))
						recorder.reset()
						require.NoError(t, db.Table(table).AutoMigrate(target))
						assert.Empty(t, recorder.schemaMutations())
					}
					columns, err := db.Table(table).Migrator().ColumnTypes(&migrationDecimalV3{})
					require.NoError(t, err)
					for _, column := range columns {
						if column.Name() == "price" {
							precision, scale, ok := column.DecimalSize()
							require.True(t, ok)
							assert.EqualValues(t, 12, precision)
							assert.EqualValues(t, 6, scale)
							nullable, ok := column.Nullable()
							require.True(t, ok)
							assert.False(t, nullable)
						}
					}
					require.NoError(t, db.Table(table).Create(&map[string]any{"id": 2}).Error)
					var prices []float64
					require.NoError(t, db.Table(table).Order("id").Pluck("price", &prices).Error)
					assert.Equal(t, []float64{12.345678, 1.25}, prices)
				})
			}
		})
	}
}

// newReferralIntegrationDatabase always creates its own database (or SQLite
// file). It cannot truncate an operator's database or share fixtures with other
// test processes. The returned DSN is also used by the process-race tests.
func newReferralIntegrationDatabase(t *testing.T, dialect string) (*gorm.DB, string) {
	t.Helper()
	if dialect == "sqlite" {
		path := filepath.Join(t.TempDir(), "referral.db")
		db, err := gorm.Open(sqlite.Open(path), newGormConfig(true))
		require.NoError(t, err)
		connection, err := db.DB()
		require.NoError(t, err)
		t.Cleanup(func() { _ = connection.Close() })
		return db, path
	}
	originalDSN := os.Getenv("TEST_" + strings.ToUpper(dialect) + "_DSN")
	if originalDSN == "" {
		t.Skip("isolated database DSN is not configured")
	}
	name := "newapi_referral_" + strconv.FormatInt(time.Now().UnixNano(), 10)
	var adminDialector, databaseDialector gorm.Dialector
	var isolatedDSN string
	if dialect == "mysql" {
		configuration, err := sqlmysql.ParseDSN(originalDSN)
		require.NoError(t, err)
		host, _, err := net.SplitHostPort(configuration.Addr)
		require.NoError(t, err)
		require.True(t, net.ParseIP(host).IsLoopback(), "only isolated loopback database instances are accepted")
		adminDialector = mysql.Open(originalDSN)
		configuration.DBName = name
		configuration.ParseTime = true
		isolatedDSN = configuration.FormatDSN()
		databaseDialector = mysqlMigrationDialector{mysql.Dialector{Config: &mysql.Config{DSN: isolatedDSN}}}
	} else {
		configuration, err := url.Parse(originalDSN)
		require.NoError(t, err)
		require.True(t, net.ParseIP(configuration.Hostname()).IsLoopback(), "only isolated loopback database instances are accepted")
		adminDialector = postgres.Open(originalDSN)
		configuration.Path = "/" + name
		isolatedDSN = configuration.String()
		databaseDialector = postgresMigrationDialector{postgres.Dialector{Config: &postgres.Config{DSN: isolatedDSN, PreferSimpleProtocol: true}}}
	}
	admin, err := gorm.Open(adminDialector, newGormConfig(false))
	require.NoError(t, err)
	statement := "CREATE DATABASE " + name
	if dialect == "mysql" {
		statement += " CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
	}
	require.NoError(t, admin.Exec(statement).Error)
	db, err := gorm.Open(databaseDialector, newGormConfig(false))
	require.NoError(t, err)
	t.Cleanup(func() {
		connection, closeErr := db.DB()
		if closeErr == nil {
			_ = connection.Close()
		}
		assert.NoError(t, admin.Exec("DROP DATABASE "+name).Error)
		connection, closeErr = admin.DB()
		if closeErr == nil {
			_ = connection.Close()
		}
	})
	return db, isolatedDSN
}

func TestReferralMigrationFreshAndExistingDatabases(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		for _, legacy := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/legacy=%t", dialect, legacy), func(t *testing.T) {
				db, _ := newReferralIntegrationDatabase(t, dialect)
				var version string
				versionQuery := "SELECT version()"
				if dialect == "sqlite" {
					versionQuery = "SELECT sqlite_version()"
				}
				require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
				t.Logf("real database version: %s", version)
				if legacy {
					// Reconstruct the exact affected pre-feature fields while retaining
					// all unrelated model fields and their existing constraints.
					for _, model := range []struct {
						table  string
						typeOf reflect.Type
					}{{"users", reflect.TypeFor[User]()}, {"top_ups", reflect.TypeFor[TopUp]()}} {
						fields := make([]reflect.StructField, 0, model.typeOf.NumField())
						for index := range model.typeOf.NumField() {
							field := model.typeOf.Field(index)
							if !field.IsExported() || field.Name == "ReferralRateBPS" || field.Name == "ReferralExpiresAt" || field.Name == "RegistrationAffCode" || field.Name == "CreditedQuota" || field.Name == "WaffoMerchantID" {
								continue
							}
							if field.Name == "Quota" || field.Name == "AffQuota" || field.Name == "AffHistoryQuota" {
								field.Tag = reflect.StructTag(strings.ReplaceAll(string(field.Tag), "type:bigint", "type:int"))
							}
							fields = append(fields, field)
						}
						require.NoError(t, db.Table(model.table).AutoMigrate(reflect.New(reflect.StructOf(fields)).Interface()))
					}
					legacyDatabaseType := map[string]common.DatabaseType{"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL}[dialect]
					require.NoError(t, ensureUserQuotaColumns(db, legacyDatabaseType), "the representative old schema must pass the existing startup guard")
					legacyColumns, err := db.Migrator().ColumnTypes("users")
					require.NoError(t, err)
					for _, column := range legacyColumns {
						if column.Name() == "quota" || column.Name() == "aff_quota" || column.Name() == "aff_history" || column.Name() == "used_quota" {
							t.Logf("pre-feature physical column %s: %s", column.Name(), column.DatabaseTypeName())
						}
					}
					require.NoError(t, db.Table("users").Create(map[string]any{
						"id": 1, "username": "historical-inviter", "password": "password-hash", "aff_code": "historical-inviter-code", "quota": -50,
						"aff_quota": 75, "aff_history": 125, "status": common.UserStatusEnabled, "created_at": 100,
					}).Error)
					require.NoError(t, db.Table("users").Create(map[string]any{
						"id": 2, "username": "historical-invitee", "password": "password-hash", "aff_code": "historical-invitee-code", "inviter_id": 1, "quota": 250, "created_at": 200,
					}).Error)
					require.NoError(t, db.Table("top_ups").Create(map[string]any{
						"user_id": 2, "trade_no": "historical-order", "amount": 100, "money": 90, "status": common.TopUpStatusSuccess,
						"payment_method": "alipay", "payment_provider": PaymentProviderEpay, "create_time": 300, "complete_time": 400,
					}).Error)
				}
				require.NoError(t, db.AutoMigrate(&User{}, &TopUp{}, &Option{}, &ReferralRebate{}, &AffiliateTransfer{}))
				require.NoError(t, InitializeReferralRebateRule(db))
				merchantID := "merchant-at-checkout"
				quota := 100
				merchantOrder := TopUp{UserId: 2, TradeNo: "merchant-snapshot-order", Amount: 10, Money: 10, CreditedQuota: &quota, WaffoMerchantID: &merchantID, PaymentProvider: PaymentProviderWaffo, PaymentMethod: PaymentMethodWaffo, Status: common.TopUpStatusPending}
				require.NoError(t, db.Create(&merchantOrder).Error)
				recorder := &migrationSQLRecorder{}
				repeated := db.Session(&gorm.Session{Logger: recorder})
				require.NoError(t, repeated.AutoMigrate(&User{}, &TopUp{}, &Option{}, &ReferralRebate{}, &AffiliateTransfer{}))
				require.NoError(t, InitializeReferralRebateRule(repeated))
				assert.Empty(t, recorder.schemaMutations(), "the second startup must not alter the schema again")
				var storedMerchantOrder TopUp
				require.NoError(t, db.First(&storedMerchantOrder, merchantOrder.Id).Error)
				require.NotNil(t, storedMerchantOrder.WaffoMerchantID)
				assert.Equal(t, merchantID, *storedMerchantOrder.WaffoMerchantID)
				assert.Equal(t, quota, *storedMerchantOrder.CreditedQuota)
				assert.Equal(t, common.TopUpStatusPending, storedMerchantOrder.Status)
				if legacy {
					var owner, invitee User
					require.NoError(t, db.First(&owner, 1).Error)
					require.NoError(t, db.First(&invitee, 2).Error)
					assert.Equal(t, -50, owner.Quota)
					assert.Equal(t, 75, owner.AffQuota)
					assert.Equal(t, 125, owner.AffHistoryQuota)
					assert.Equal(t, 1, invitee.InviterId)
					assert.EqualValues(t, 200, invitee.CreatedAt)
					assert.Zero(t, invitee.ReferralRateBPS)
					assert.Zero(t, invitee.ReferralExpiresAt)
					var order TopUp
					require.NoError(t, db.First(&order, 1).Error)
					assert.Equal(t, common.TopUpStatusSuccess, order.Status)
					assert.EqualValues(t, 400, order.CompleteTime)
					assert.Nil(t, order.CreditedQuota)
					assert.Nil(t, order.WaffoMerchantID, "migration must not invent a merchant for historical orders")
					assert.Error(t, db.Create(&User{Username: owner.Username, AffCode: "different-code"}).Error)
					assert.Error(t, db.Create(&User{Username: "different-user", AffCode: owner.AffCode}).Error)
					assert.Error(t, db.Create(&TopUp{TradeNo: order.TradeNo}).Error)
				}
				// Exercise the physical column range rather than infer it from Go types.
				maximum := User{Username: "maximum-wallet", AffCode: "maximum-code", Quota: common.MaxWalletQuota, AffQuota: common.MaxWalletQuota, AffHistoryQuota: common.MaxWalletQuota}
				require.NoError(t, db.Create(&maximum).Error)
				var stored User
				require.NoError(t, db.First(&stored, maximum.Id).Error)
				assert.Equal(t, maximum.Quota, stored.Quota)
				assert.Equal(t, maximum.AffQuota, stored.AffQuota)
				assert.Equal(t, maximum.AffHistoryQuota, stored.AffHistoryQuota)
				fact := ReferralRebate{TopUpID: 999, TradeNo: "unique-rebate", InviterID: 1, InviteeID: 2, CreditedQuota: common.MaxWalletQuota, RateBPS: 10000, RewardQuota: common.MaxWalletQuota, SettledAt: 400, CreatedAt: 400}
				require.NoError(t, db.Create(&fact).Error)
				fact.ID = 0
				assert.Error(t, db.Create(&fact).Error)
				transfer := AffiliateTransfer{UserID: maximum.Id, RequestID: "durable-transfer-request", Quota: common.MaxWalletQuota, CreatedAt: 400}
				require.NoError(t, db.Create(&transfer).Error)
				transfer.ID = 0
				assert.Error(t, db.Create(&transfer).Error)
				assert.True(t, db.Migrator().HasIndex(&User{}, "InviterId"))
				assert.True(t, db.Migrator().HasIndex(&TopUp{}, "TradeNo"))
			})
		}
	}
}
