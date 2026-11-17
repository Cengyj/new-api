package service

import (
	"maps"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPaymentReturnURLUsesSuppliedDefaultDashboardPath(t *testing.T) {
	previousAddress := system_setting.ServerAddress
	system_setting.ServerAddress = "https://dashboard.example.com/"
	t.Cleanup(func() { system_setting.ServerAddress = previousAddress })

	assert.Equal(t, "https://dashboard.example.com/wallet", PaymentReturnURL("/wallet"))
}

func TestConfiguredURLsDuringAddressPublication(t *testing.T) {
	common.OptionMapRWMutex.Lock()
	previousServer, previousPublic := system_setting.ServerAddress, system_setting.TaskPublicAddress
	previousSecret := common.CryptoSecret
	common.CryptoSecret = "isolated-configured-url-test"
	common.OptionMapRWMutex.Unlock()
	t.Cleanup(func() {
		common.OptionMapRWMutex.Lock()
		system_setting.ServerAddress, system_setting.TaskPublicAddress = previousServer, previousPublic
		common.CryptoSecret = previousSecret
		common.OptionMapRWMutex.Unlock()
	})
	access, err := IssueTaskArtifactAccess("task-1", "image")
	require.NoError(t, err)
	artifactSuffix := "/v1/tasks/task-1/artifacts/image/content?access=" + access
	for _, test := range []struct {
		name          string
		publicAddress string
		read          func() (string, error)
		oldURL        string
		newURL        string
	}{
		{"payment", "", func() (string, error) { return PaymentReturnURL("/wallet"), nil }, "https://old.example/base/wallet", "https://new.example/longer-prefix/wallet"},
		{"plugin_login", "", func() (string, error) { return PluginLoginRedirectURI("vendor"), nil }, "https://old.example/base/oauth/plugin/vendor/callback", "https://new.example/longer-prefix/oauth/plugin/vendor/callback"},
		{"artifact_public", "https://old.example/base/", func() (string, error) { return BuildTaskArtifactContentURL("task-1", "image") }, "https://old.example/base" + artifactSuffix, "https://new.example/longer-prefix" + artifactSuffix},
		{"artifact_fallback", "", func() (string, error) { return BuildTaskArtifactContentURL("task-1", "image") }, "https://old.example/base" + artifactSuffix, "https://new.example/longer-prefix" + artifactSuffix},
	} {
		t.Run(test.name, func(t *testing.T) {
			common.OptionMapRWMutex.Lock()
			system_setting.ServerAddress = "https://old.example/base/"
			system_setting.TaskPublicAddress = test.publicAddress
			common.OptionMapRWMutex.Unlock()
			start, published := make(chan struct{}), make(chan struct{})
			go func() {
				<-start
				// Dynamic saves and node reloads publish addresses under this lock.
				common.OptionMapRWMutex.Lock()
				system_setting.ServerAddress = "https://new.example/longer-prefix/"
				if test.publicAddress != "" {
					system_setting.TaskPublicAddress = "https://new.example/longer-prefix/"
				}
				common.OptionMapRWMutex.Unlock()
				close(published)
			}()
			close(start)
			actual, readErr := test.read()
			<-published
			require.NoError(t, readErr)
			assert.Contains(t, []string{test.oldURL, test.newURL}, actual)
			actual, readErr = test.read()
			require.NoError(t, readErr)
			assert.Equal(t, test.newURL, actual)
		})
	}
}

func TestConfiguredURLsFollowMixedAddressSaveAndReload(t *testing.T) {
	database := useNodeSync(t)
	common.OptionMapRWMutex.Lock()
	previousOptions := common.OptionMap
	previousServer, previousPublic := system_setting.ServerAddress, system_setting.TaskPublicAddress
	previousPasskey, previousPayment := *system_setting.GetPasskeySettings(), *operation_setting.GetPaymentSetting()
	previousSecret := common.CryptoSecret
	common.OptionMap = maps.Clone(model.CurrentRequestPolicy().Options)
	system_setting.ServerAddress, system_setting.TaskPublicAddress = "", ""
	*system_setting.GetPasskeySettings() = system_setting.PasskeySettings{}
	*operation_setting.GetPaymentSetting() = operation_setting.PaymentSetting{EpaySignType: operation_setting.EpaySignTypeMD5}
	common.CryptoSecret = "isolated-persisted-url-test"
	common.OptionMapRWMutex.Unlock()
	t.Cleanup(func() {
		common.OptionMapRWMutex.Lock()
		common.OptionMap = previousOptions
		system_setting.ServerAddress, system_setting.TaskPublicAddress = previousServer, previousPublic
		*system_setting.GetPasskeySettings(), *operation_setting.GetPaymentSetting() = previousPasskey, previousPayment
		common.CryptoSecret = previousSecret
		common.OptionMapRWMutex.Unlock()
	})
	access, err := IssueTaskArtifactAccess("task-1", "image")
	require.NoError(t, err)
	artifactSuffix := "/v1/tasks/task-1/artifacts/image/content?access=" + access
	for _, operation := range []string{"save", "reload"} {
		for _, public := range []bool{false, true} {
			name := operation + "/fallback"
			if public {
				name = operation + "/public"
			}
			t.Run(name, func(t *testing.T) {
				require.NoError(t, model.UpdateOptionsBulk(map[string]string{
					"ServerAddress": "https://old.example/old/", "TaskPublicAddress": "https://media.example/old/",
				}))
				values := map[string]string{"ServerAddress": "https://new.example/new/", "TaskPublicAddress": ""}
				artifactBase := "https://new.example/new"
				if public {
					values["TaskPublicAddress"] = "https://media.example/new/"
					artifactBase = "https://media.example/new"
				}
				if operation == "reload" {
					// Represent a peer's durable save before this node consumes it.
					for key, value := range values {
						require.NoError(t, database.Save(&model.Option{Key: key, Value: value}).Error)
					}
				}
				start := make(chan struct{})
				published := make(chan error, 1)
				go func() {
					<-start
					if operation == "reload" {
						published <- model.LoadOptionsFromDatabase()
					} else {
						published <- model.UpdateOptionsBulk(values)
					}
				}()
				close(start)
				contentURL, readErr := BuildTaskArtifactContentURL("task-1", "image")
				publishErr := <-published
				require.NoError(t, readErr)
				require.NoError(t, publishErr)
				assert.Contains(t, []string{"https://media.example/old" + artifactSuffix, artifactBase + artifactSuffix}, contentURL,
					"a reader must see a complete old or new address configuration")
				assert.Equal(t, "https://new.example/new/wallet", PaymentReturnURL("/wallet"))
				assert.Equal(t, "https://new.example/new/oauth/plugin/vendor/callback", PluginLoginRedirectURI("vendor"))
				contentURL, err = BuildTaskArtifactContentURL("task-1", "image")
				require.NoError(t, err)
				assert.Equal(t, artifactBase+artifactSuffix, contentURL)
				for key, value := range values {
					var stored model.Option
					require.NoError(t, database.Where(&model.Option{Key: key}).First(&stored).Error)
					assert.Equal(t, value, stored.Value)
				}
			})
		}
	}
}
