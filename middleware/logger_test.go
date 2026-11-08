package middleware

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSetUpLoggerMasksQueryCredentials(t *testing.T) {
	previousMode, previousWriter := gin.Mode(), gin.DefaultWriter
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() {
		gin.SetMode(previousMode)
		gin.DefaultWriter = previousWriter
	})

	for _, tc := range []struct{ target, loggedPath string }{
		{"/v1/models?%6bey=first&key=second&API-Key=third&session_token=fourth&alt=sse",
			"/v1/models?API-Key=%2A%2A%2Amasked%2A%2A%2A&alt=sse&key=%2A%2A%2Amasked%2A%2A%2A&session_token=%2A%2A%2Amasked%2A%2A%2A"},
		{"/v1/models%23test%25?key=#secret&alt=#sse",
			"/v1/models%23test%25?alt=%23sse&key=%2A%2A%2Amasked%2A%2A%2A"},
		{"//v1%2Fmodels?key=secret", "//v1%2Fmodels?key=%2A%2A%2Amasked%2A%2A%2A"},
		{"/v1/models?key=bad%ZZ&%ZZ=bad&token=bad;other=true&alt=sse", "/v1/models?alt=sse"},
		{"/v1/models?key=bad%ZZ", "/v1/models?"},
		{"/v1/models?alt=sse&api-version=2024-02-01", "/v1/models?alt=sse&api-version=2024-02-01"},
		{"/v1/models", "/v1/models"},
		{"/%61pi/oauth/test?code=secret&state=secret", "/%61pi/oauth/test"},
		{"/%61pi/user/epay/notify?%73ign=first&sign=second&key=secret&keep=ok", "/%61pi/user/epay/notify"},
		{"/api/subscription/epay/notify?sign=bad%ZZ&%ZZ=bad&code=secret;state=secret", "/api/subscription/epay/notify"},
		{"/api/waffo-pancake/webhook/%70roduction?signature=secret&session_token=secret", "/api/waffo-pancake/webhook/%70roduction"},
		{"/oauth/%70rovider?%63ode=first&code=second&state=bad%ZZ", "/oauth/%70rovider"},
		{"/v1/models%0A%5BGIN%5D%20forged", "/v1/models%0A%5BGIN%5D%20forged"},
		{"/v1/models%0D%0A%5BGIN%5D%20forged?token=secret&note=ok%0Abad",
			"/v1/models%0D%0A%5BGIN%5D%20forged?note=ok%0Abad&token=%2A%2A%2Amasked%2A%2A%2A"},
		{"/api/oauth/pro%09vider%1B?code=secret&state=secret", "/api/oauth/pro%09vider%1B"},
		{"/api/oauth/provider%3Fpart%23fragment?code=secret&state=secret", "/api/oauth/provider%3Fpart%23fragment"},
		{"/api/waffo-pancake/webhook/%3Fprod?signature=secret", "/api/waffo-pancake/webhook/%3Fprod"},
		{"/api%2Foauth/provider?code=secret&state=secret", "/api%2Foauth/provider"},
		{"/v1/models%3Fpart?key=secret&alt=sse", "/v1/models%3Fpart?alt=sse&key=%2A%2A%2Amasked%2A%2A%2A"},
		{"/v1/models?%73ession_token=secret&note=line1%0D%0Aline2",
			"/v1/models?note=line1%0D%0Aline2&session_token=%2A%2A%2Amasked%2A%2A%2A"},
	} {
		t.Run(tc.target, func(t *testing.T) {
			var output bytes.Buffer
			gin.DefaultWriter = &output
			router := gin.New()
			SetUpLogger(router)
			request := httptest.NewRequest(http.MethodGet, tc.target, nil)
			originalURL := *request.URL
			router.NoRoute(func(c *gin.Context) {
				assert.Equal(t, originalURL, *c.Request.URL)
				assert.Equal(t, tc.target, c.Request.RequestURI)
				c.Status(http.StatusUnauthorized)
			})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)

			require.Equal(t, http.StatusUnauthorized, response.Code)
			assert.Equal(t, 1, strings.Count(output.String(), "\n"), "one request produces one physical log line")
			assert.False(t, strings.ContainsAny(output.String(), "\r\t\x1b"), "path controls stay escaped")
			_, loggedPath, found := strings.Cut(strings.TrimSuffix(output.String(), "\n"), "GET ")
			require.True(t, found)
			assert.Equal(t, tc.loggedPath, loggedPath)
			assert.Equal(t, originalURL, *request.URL)
			assert.Equal(t, tc.target, request.RequestURI)
		})
	}
}

func TestSetUpLoggerKeepsSafePathWhenHandlerRewritesURL(t *testing.T) {
	previousMode, previousWriter := gin.Mode(), gin.DefaultWriter
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() {
		gin.SetMode(previousMode)
		gin.DefaultWriter = previousWriter
	})

	for _, tc := range []struct{ target, loggedPath, handlerQuery string }{
		{"/v1/models?key=never-log-original&alt=sse",
			"/v1/models?alt=sse&key=%2A%2A%2Amasked%2A%2A%2A", ""},
		{"/api/oauth/provider?code=never-log-original",
			"/api/oauth/provider", "code=never-log-rewritten"},
	} {
		t.Run(tc.target, func(t *testing.T) {
			var output bytes.Buffer
			gin.DefaultWriter = &output
			router := gin.New()
			SetUpLogger(router)
			request := httptest.NewRequest(http.MethodGet, tc.target, nil)
			originalURL := *request.URL
			handlerURL := originalURL
			handlerURL.Path = "/internal"
			handlerURL.RawPath = ""
			handlerURL.RawQuery = tc.handlerQuery
			router.NoRoute(func(c *gin.Context) {
				assert.Equal(t, originalURL, *c.Request.URL)
				assert.Equal(t, tc.target, c.Request.RequestURI)
				*c.Request.URL = handlerURL
				c.Request.RequestURI = handlerURL.RequestURI()
				c.Status(http.StatusNoContent)
			})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)

			require.Equal(t, http.StatusNoContent, response.Code)
			_, loggedPath, found := strings.Cut(strings.TrimSuffix(output.String(), "\n"), "GET ")
			require.True(t, found)
			assert.Equal(t, tc.loggedPath, loggedPath)
			assert.NotContains(t, output.String(), "never-log-")
			assert.Equal(t, 1, strings.Count(output.String(), "\n"))
			assert.Equal(t, handlerURL, *request.URL, "logging must not rewrite or restore the handler request")
			assert.Equal(t, handlerURL.RequestURI(), request.RequestURI)
		})
	}
}

func TestAccessAndPanicLogsFollowLogRotation(t *testing.T) {
	previousMode, previousWriter, previousErrorWriter := gin.Mode(), gin.DefaultWriter, gin.DefaultErrorWriter
	previousLogDir := *common.LogDir
	gin.SetMode(gin.TestMode)
	*common.LogDir = t.TempDir()
	t.Cleanup(func() {
		gin.SetMode(previousMode)
		gin.DefaultWriter, gin.DefaultErrorWriter = previousWriter, previousErrorWriter
		*common.LogDir = previousLogDir
	})

	logger.SetupLogger()
	router := gin.New()
	router.Use(PanicRecover())
	SetUpLogger(router)
	router.GET("/ok/:step", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	router.GET("/panic", func(c *gin.Context) { panic("rotation-panic-marker") })
	router.GET("/api/oauth/provider", func(c *gin.Context) {
		assert.Equal(t, "rotation-code-secret", c.Query("code"))
		assert.Equal(t, "rotation-state-secret", c.Query("state"))
		c.Request.URL.RawQuery = "code=rewritten-secret"
		c.Status(http.StatusNoContent)
	})

	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/ok/before-rotation", nil))
	content, err := os.ReadFile(logger.GetCurrentLogPath())
	require.NoError(t, err)
	assert.Contains(t, string(content), "/ok/before-rotation")

	// Rotation closes the file the middleware saw at startup. The new file may
	// reuse the old name when both calls land in the same second; the checks
	// below hold either way because only the new descriptor stays open.
	logger.SetupLogger()
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/ok/after-rotation", nil))
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/ok/escaped%0Apath?key=rotation-key-secret", nil))
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/oauth/provider?code=rotation-code-secret&state=rotation-state-secret", nil))
	panicResponse := httptest.NewRecorder()
	router.ServeHTTP(panicResponse, httptest.NewRequest(http.MethodGet, "/panic", nil))
	require.Equal(t, http.StatusInternalServerError, panicResponse.Code)

	content, err = os.ReadFile(logger.GetCurrentLogPath())
	require.NoError(t, err)
	assert.Contains(t, string(content), "/ok/after-rotation")
	assert.Contains(t, string(content), "/ok/escaped%0Apath?key=%2A%2A%2Amasked%2A%2A%2A\n")
	assert.Contains(t, string(content), "/api/oauth/provider\n")
	for _, secret := range []string{"rotation-code-secret", "rotation-state-secret", "rotation-key-secret", "rewritten-secret"} {
		assert.NotContains(t, string(content), secret)
	}
	assert.Contains(t, string(content), "[Recovery]")
	assert.Contains(t, string(content), "rotation-panic-marker\n")
	assert.Contains(t, string(content), "middleware/logger_test.go")
}

func TestSetUpLoggerOmitsQueryCredentialsTakenOutByHandlers(t *testing.T) {
	previousMode, previousWriter := gin.Mode(), gin.DefaultWriter
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() {
		gin.SetMode(previousMode)
		gin.DefaultWriter = previousWriter
	})

	for _, tc := range []struct{ target, loggedPath string }{
		{"/v1beta/models/veo:predictLongRunning?key=sk-secret", "/v1beta/models/veo:predictLongRunning?key=%2A%2A%2Amasked%2A%2A%2A"},
		{"/v1beta/models/veo:predictLongRunning?key=sk-secret&alt=sse", "/v1beta/models/veo:predictLongRunning?alt=sse&key=%2A%2A%2Amasked%2A%2A%2A"},
	} {
		t.Run(tc.target, func(t *testing.T) {
			var output bytes.Buffer
			gin.DefaultWriter = &output
			router := gin.New()
			SetUpLogger(router)
			router.POST("/v1beta/models/:action", NativeRouteCredential("google"), func(c *gin.Context) {
				c.Status(http.StatusNoContent)
			})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, tc.target, nil))

			require.Equal(t, http.StatusNoContent, response.Code)
			assert.NotContains(t, output.String(), "sk-secret")
			_, loggedPath, found := strings.Cut(strings.TrimSuffix(output.String(), "\n"), "POST ")
			require.True(t, found)
			assert.Equal(t, tc.loggedPath, loggedPath)
		})
	}
}
