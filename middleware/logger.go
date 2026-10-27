package middleware

import (
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
)

const RouteTagKey = "route_tag"
const accessLogPathKey = "access_log_path"

func RouteTag(tag string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(RouteTagKey, tag)
		c.Next()
	}
}

func SetUpLogger(server *gin.Engine) {
	server.Use(redactTaskArtifactAccessQuery())
	server.Use(func(c *gin.Context) {
		// Freeze the safe log value before handlers can rewrite the request.
		// Decode only for callback classification; keep all displayed paths escaped.
		requestURL := c.Request.URL
		requestPath := requestURL.Path
		path := requestURL.EscapedPath()
		paymentCallback := false
		switch requestPath {
		case "/api/user/epay/notify", "/api/subscription/epay/notify", "/api/subscription/epay/return",
			"/api/stripe/webhook", "/api/creem/webhook", "/api/waffo/webhook":
			paymentCallback = true
		}
		// Payment and OAuth callbacks can carry usable signatures, one-time
		// codes and state. Only redact the log; verification needs the full query.
		sensitiveCallback := paymentCallback || strings.HasPrefix(requestPath, "/api/waffo-pancake/webhook/") ||
			strings.HasPrefix(requestPath, "/api/oauth/") || strings.HasPrefix(requestPath, "/oauth/")
		if !sensitiveCallback && requestURL.RawQuery != "" {
			query := requestURL.Query().Encode()
			path += relaycommon.SanitizeURLForLog("?" + query)
		}
		c.Set(accessLogPathKey, path)
		c.Next()
	})
	server.Use(gin.LoggerWithFormatter(func(param gin.LogFormatterParams) string {
		requestID, _ := param.Keys[common.RequestIdKey].(string)
		tag, _ := param.Keys[RouteTagKey].(string)
		if tag == "" {
			tag = "web"
		}
		path, _ := param.Keys[accessLogPathKey].(string)
		return fmt.Sprintf("[GIN] %s | %s | %s | %3d | %13v | %15s | %7s %s\n",
			param.TimeStamp.Format("2006/01/02 - 15:04:05"),
			tag,
			requestID,
			param.StatusCode,
			param.Latency,
			param.ClientIP,
			param.Method,
			path,
		)
	}))
}
