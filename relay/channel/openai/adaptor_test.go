package openai

import (
	"bytes"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/dto"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"

	"github.com/gin-gonic/gin"
)

func TestConvertImageEditRequestUsesGrokArrayFieldForSingleImageOnly(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		model         string
		inputField    string
		imageCount    int
		wantImageName string
	}{
		{
			name:          "grok image edit single image keeps image array field",
			model:         "grok-imagine-image-edit",
			inputField:    "image[]",
			imageCount:    1,
			wantImageName: "image[]",
		},
		{
			name:          "grok imagine image single image keeps image array field",
			model:         "grok-imagine-image",
			inputField:    "image[]",
			imageCount:    1,
			wantImageName: "image[]",
		},
		{
			name:          "grok imagine image pro single image keeps image array field",
			model:         "grok-imagine-image-pro",
			inputField:    "image[]",
			imageCount:    1,
			wantImageName: "image[]",
		},
		{
			name:          "non grok image edit single image keeps openai field",
			model:         "gpt-image-1",
			inputField:    "image",
			imageCount:    1,
			wantImageName: "image",
		},
		{
			name:          "non grok image edit multiple images still use array field",
			model:         "gpt-image-1",
			inputField:    "image[]",
			imageCount:    2,
			wantImageName: "image[]",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			c := newMultipartImageEditContext(t, tt.inputField, tt.imageCount)
			adaptor := &Adaptor{}
			got, err := adaptor.ConvertImageRequest(c, &relaycommon.RelayInfo{
				RelayMode: relayconstant.RelayModeImagesEdits,
			}, dto.ImageRequest{Model: tt.model, Prompt: "edit prompt"})
			if err != nil {
				t.Fatalf("ConvertImageRequest returned error: %v", err)
			}

			body, ok := got.(*bytes.Buffer)
			if !ok {
				t.Fatalf("ConvertImageRequest returned %T, want *bytes.Buffer", got)
			}

			imagePartNames := multipartImagePartNames(t, body.Bytes(), c.Request.Header.Get("Content-Type"))
			if len(imagePartNames) != tt.imageCount {
				t.Fatalf("image part count = %d, want %d; names=%v", len(imagePartNames), tt.imageCount, imagePartNames)
			}
			for _, gotName := range imagePartNames {
				if gotName != tt.wantImageName {
					t.Fatalf("image part field = %q, want %q; all names=%v", gotName, tt.wantImageName, imagePartNames)
				}
			}
		})
	}
}

func newMultipartImageEditContext(t *testing.T, imageField string, imageCount int) *gin.Context {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("prompt", "edit prompt"); err != nil {
		t.Fatalf("WriteField(prompt) returned error: %v", err)
	}
	for i := 0; i < imageCount; i++ {
		part, err := writer.CreateFormFile(imageField, fmt.Sprintf("reference-%d.png", i+1))
		if err != nil {
			t.Fatalf("CreateFormFile returned error: %v", err)
		}
		if _, err := part.Write([]byte("fake png content")); err != nil {
			t.Fatalf("writing image part returned error: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("multipart writer close returned error: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/images/edits", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = req
	return c
}

func multipartImagePartNames(t *testing.T, body []byte, contentType string) []string {
	t.Helper()

	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		t.Fatalf("ParseMediaType returned error: %v", err)
	}
	if mediaType != "multipart/form-data" {
		t.Fatalf("media type = %q, want multipart/form-data", mediaType)
	}
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])

	var names []string
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("NextPart returned error: %v", err)
		}
		if part.FileName() != "" {
			names = append(names, part.FormName())
		}
		_ = part.Close()
	}
	return names
}
