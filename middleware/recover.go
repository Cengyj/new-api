package middleware

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/gin-gonic/gin"
)

func RelayPanicRecover() gin.HandlerFunc {
	return PanicRecover()
}

// IsClientDisconnectPanic reports the network failures for which recovery must
// not attempt another response. Keep request audits on the same classification.
func IsClientDisconnectPanic(failure any) bool {
	networkError, ok := failure.(*net.OpError)
	if !ok || networkError == nil {
		return false
	}
	var syscallError *os.SyscallError
	if !errors.As(networkError, &syscallError) {
		return false
	}
	message := strings.ToLower(syscallError.Error())
	return strings.Contains(message, "broken pipe") || strings.Contains(message, "connection reset by peer")
}

// PanicRecover logs through the current writer without dumping requests or
// panic values, either of which can contain payment or authentication secrets.
func PanicRecover() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if failure := recover(); failure != nil {
				_, _ = fmt.Fprintf(common.ErrorLogWriter,
					"[Recovery] %s | request_id=%q | method=%q route=%q | panic_type=%T\n%s",
					time.Now().Format(time.RFC3339), c.GetString(common.RequestIdKey),
					c.Request.Method, c.FullPath(), failure, debug.Stack())
				c.Abort()
				// A disconnected client cannot receive a response. Retain Gin's
				// network-error classification without storing its raw error text.
				if IsClientDisconnectPanic(failure) {
					return
				}
				c.JSON(http.StatusInternalServerError, gin.H{
					"error": gin.H{
						"message": "Panic detected. Please submit a issue here: https://github.com/Calcium-Ion/new-api",
						"type":    "new_api_panic",
					},
				})
			}
		}()
		c.Next()
	}
}
