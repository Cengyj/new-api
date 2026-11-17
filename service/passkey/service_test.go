package passkey

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/system_setting"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestResolveOriginsDuringServerAddressPublication(t *testing.T) {
	common.OptionMapRWMutex.RLock()
	previousAddress := system_setting.ServerAddress
	common.OptionMapRWMutex.RUnlock()
	t.Cleanup(func() {
		common.OptionMapRWMutex.Lock()
		system_setting.ServerAddress = previousAddress
		common.OptionMapRWMutex.Unlock()
	})
	for _, test := range []struct {
		name            string
		host            string
		origins         string
		previousAddress string
		nextAddress     string
		allowedOrigins  []string
	}{
		{"request_host", "request.example:7443", "", "https://old.example", "https://changed.example:9443", []string{"https://request.example:7443"}},
		{"configured_origins", "request.example:7443", "https://trusted.example", "https://old.example", "https://changed.example:9443", []string{"https://trusted.example"}},
		{"server_fallback", "", "", "https://old.example:8443", "https://changed.example:9443", []string{"https://old.example:8443", "https://changed.example:9443"}},
		{"empty_address", "", "", "", "", nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "https://request.example/passkey", nil)
			request.Host = test.host
			settings := system_setting.PasskeySettings{Origins: test.origins}
			common.OptionMapRWMutex.Lock()
			system_setting.ServerAddress = test.previousAddress
			common.OptionMapRWMutex.Unlock()
			start, published := make(chan struct{}), make(chan struct{})
			go func() {
				<-start
				common.OptionMapRWMutex.Lock()
				system_setting.ServerAddress = test.nextAddress
				common.OptionMapRWMutex.Unlock()
				close(published)
			}()
			close(start)
			origins, err := resolveOrigins(request, &settings)
			<-published
			if test.allowedOrigins == nil {
				require.EqualError(t, err, "cannot determine the Passkey origin; set it in the system settings or the Passkey settings. Host: '', ServerAddress: ''")
				assert.Nil(t, origins)
				return
			}
			require.NoError(t, err)
			require.Len(t, origins, 1)
			assert.Contains(t, test.allowedOrigins, origins[0])
			origins, err = resolveOrigins(request, &settings)
			require.NoError(t, err)
			assert.Equal(t, []string{test.allowedOrigins[len(test.allowedOrigins)-1]}, origins)
		})
	}
}
