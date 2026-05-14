package controller

import (
	"errors"
	"fmt"

	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/types"

	"github.com/gin-gonic/gin"
)

func Playground(c *gin.Context) {
	playgroundSetup(c, types.RelayFormatOpenAI, func(c *gin.Context) {
		Relay(c, types.RelayFormatOpenAI)
	})
}

// PlaygroundFor returns a handler that performs the same setup as Playground but
// dispatches to Relay() with the given format. Use this for /pg routes that need
// session auth instead of token auth (e.g. images, audio, embeddings).
func PlaygroundFor(format types.RelayFormat) gin.HandlerFunc {
	return func(c *gin.Context) {
		playgroundSetup(c, format, func(c *gin.Context) {
			Relay(c, format)
		})
	}
}

// PlaygroundTask is the playground entrypoint for task-style relay endpoints
// (video, midjourney, suno...) that go through controller.RelayTask.
func PlaygroundTask(c *gin.Context) {
	playgroundSetup(c, types.RelayFormatTask, RelayTask)
}

// PlaygroundTaskFetch is the playground entrypoint for fetching task results.
func PlaygroundTaskFetch(c *gin.Context) {
	playgroundSetup(c, types.RelayFormatTask, RelayTaskFetch)
}

func playgroundSetup(c *gin.Context, format types.RelayFormat, next func(c *gin.Context)) {
	var newAPIError *types.NewAPIError

	defer func() {
		if newAPIError != nil {
			c.JSON(newAPIError.StatusCode, gin.H{
				"error": newAPIError.ToOpenAIError(),
			})
		}
	}()

	useAccessToken := c.GetBool("use_access_token")
	if useAccessToken {
		newAPIError = types.NewError(errors.New("暂不支持使用 access token"), types.ErrorCodeAccessDenied, types.ErrOptionWithSkipRetry())
		return
	}

	relayInfo, err := relaycommon.GenRelayInfo(c, format, nil, nil)
	if err != nil {
		newAPIError = types.NewError(err, types.ErrorCodeInvalidRequest, types.ErrOptionWithSkipRetry())
		return
	}

	userId := c.GetInt("id")

	// Write user context to ensure acceptUnsetRatio is available
	userCache, err := model.GetUserCache(userId)
	if err != nil {
		newAPIError = types.NewError(err, types.ErrorCodeQueryDataError, types.ErrOptionWithSkipRetry())
		return
	}
	userCache.WriteContext(c)

	tempToken := &model.Token{
		UserId: userId,
		Name:   fmt.Sprintf("playground-%s", relayInfo.UsingGroup),
		Group:  relayInfo.UsingGroup,
	}
	_ = middleware.SetupContextForToken(c, tempToken)

	next(c)
}
