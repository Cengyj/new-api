package controller

import (
	"math"
	"strconv"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
)

func GetReferralRebateRule(c *gin.Context) {
	rule, err := model.GetReferralRebateRule()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, rule)
}

func SaveReferralRebateRule(c *gin.Context) {
	var request struct {
		Enabled    *bool   `json:"enabled"`
		Percentage *string `json:"percentage"`
		ValidDays  *string `json:"valid_days"`
	}
	if common.DecodeJson(c.Request.Body, &request) != nil || request.Enabled == nil || request.Percentage == nil || request.ValidDays == nil {
		common.ApiErrorT(c, "Invalid referral rebate rule")
		return
	}
	rule, err := model.ParseReferralRebateRule(*request.Enabled, *request.Percentage, *request.ValidDays)
	if err == nil {
		err = model.SaveReferralRebateRule(rule)
	}
	if err != nil {
		common.ApiError(c, err)
		return
	}
	// Return the committed value. A subsequent read/refresh cannot turn a
	// successful save into a misleading failure or replace it with an older rule.
	common.ApiSuccess(c, rule)
}

func GetReferralSummary(c *gin.Context) {
	result, err := model.GetReferralSummary(c.Request.Context(), c.GetInt("id"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

func referralPagination(c *gin.Context) (*common.PageInfo, bool) {
	page := common.GetPageQuery(c)
	if page.Page < 1 || page.PageSize < 1 || page.Page-1 > math.MaxInt32/page.PageSize {
		common.ApiErrorT(c, "Invalid parameters")
		return nil, false
	}
	return page, true
}

func GetReferralInvitees(c *gin.Context) {
	page, ok := referralPagination(c)
	if !ok {
		return
	}
	result, err := model.ListReferralInvitees(c.Request.Context(), c.GetInt("id"), page.GetStartIdx(), page.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

func GetReferralRebates(c *gin.Context) {
	page, ok := referralPagination(c)
	if !ok {
		return
	}
	values := make(map[string]int64, 4)
	for _, key := range []string{"inviter_id", "invitee_id", "start_time", "end_time"} {
		raw := c.Query(key)
		if raw == "" {
			continue
		}
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value <= 0 || value > common.MaxWalletQuota {
			common.ApiErrorT(c, "Invalid parameters")
			return
		}
		values[key] = value
	}
	filter := model.ReferralRebateFilter{InviterID: int(values["inviter_id"]), InviteeID: int(values["invitee_id"]), TradeNo: c.Query("trade_no"), StartTime: values["start_time"], EndTime: values["end_time"]}
	if utf8.RuneCountInString(filter.TradeNo) > 255 || filter.StartTime > 0 && filter.EndTime > 0 && filter.EndTime <= filter.StartTime {
		common.ApiErrorT(c, "Invalid parameters")
		return
	}
	result, err := model.ListReferralRebates(c.Request.Context(), filter, page.GetStartIdx(), page.GetPageSize())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}
