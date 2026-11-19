package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"time"

	"github.com/navidrome/navidrome/model"
	"github.com/navidrome/navidrome/model/request"
	"github.com/navidrome/navidrome/tests"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("SiteRoom", func() {
	var (
		srv    *Server
		mfRepo *tests.MockMediaFileRepo
		admin  model.User
	)

	resetRoom := func() {
		listeningRoom.Lock()
		listeningRoom.Queue = []roomEntry{}
		listeningRoom.Index = 0
		listeningRoom.Playing = false
		listeningRoom.Position = 0
		listeningRoom.UpdatedAt = time.Now().UnixMilli()
		listeningRoom.Version = 0
		listeningRoom.Session = "test-session"
		listeningRoom.Devices = map[string]roomDevice{}
		listeningRoom.Announcement = nil
		listeningRoom.AnnouncementSeq = 0
		listeningRoom.AnnouncedAt = map[string]time.Time{}
		listeningRoom.Unlock()
	}

	postRoom := func(user model.User, payload map[string]any) *httptest.ResponseRecorder {
		body, err := json.Marshal(payload)
		Expect(err).ToNot(HaveOccurred())
		req := httptest.NewRequest(http.MethodPost, "/site/room", bytes.NewReader(body))
		req = req.WithContext(request.WithUser(req.Context(), user))
		rec := httptest.NewRecorder()
		srv.changeRoom(rec, req)
		return rec
	}

	BeforeEach(func() {
		resetRoom()
		DeferCleanup(resetRoom)

		ds := &tests.MockDataStore{}
		mfRepo = ds.MediaFile(context.Background()).(*tests.MockMediaFileRepo)
		mfRepo.SetData(model.MediaFiles{
			{
				ID:        "song-1",
				Title:     "First Track",
				Artist:    "Artist One",
				ArtistID:  "ar-1",
				Album:     "Debut Album",
				AlbumID:   "al-1",
				Year:      2021,
				Duration:  215.5,
				LibraryID: 1,
			},
			{
				ID:          "song-2",
				Title:       "Second Track",
				Artist:      "Artist Two",
				ArtistID:    "ar-2",
				Album:       "Archive Release",
				AlbumID:     "al-2",
				ReleaseYear: 2018,
				Duration:    180,
				LibraryID:   2,
			},
		})
		srv = &Server{ds: ds}
		admin = model.User{ID: "u-admin", Name: "Admin", IsAdmin: true}
	})

	It("returns duration, album, and year metadata for added entries and hides details when unavailable", func() {
		joinRec := postRoom(admin, map[string]any{
			"action": "join",
			"device": "dev-admin",
		})
		Expect(joinRec.Code).To(Equal(http.StatusOK))

		addRec := postRoom(admin, map[string]any{
			"action":  "add",
			"device":  "dev-admin",
			"session": "test-session",
			"songIds": []string{"song-1", "song-2"},
		})
		Expect(addRec.Code).To(Equal(http.StatusOK))

		var roomPayload struct {
			Queue []roomEntry `json:"queue"`
		}
		Expect(json.Unmarshal(addRec.Body.Bytes(), &roomPayload)).To(Succeed())
		Expect(roomPayload.Queue).To(HaveLen(2))

		Expect(roomPayload.Queue[0].Album).To(Equal("Debut Album"))
		Expect(roomPayload.Queue[0].Year).To(Equal(2021))
		Expect(roomPayload.Queue[0].Duration).To(Equal(215.5))

		Expect(roomPayload.Queue[1].Album).To(Equal("Archive Release"))
		Expect(roomPayload.Queue[1].Year).To(Equal(2018))
		Expect(roomPayload.Queue[1].Duration).To(Equal(180.0))

		// 仅拥有曲库 1 权限的用户应看不到曲库 2 曲目的专辑和年份
		restricted := model.User{
			ID:        "u-restricted",
			Name:      "Guest",
			Libraries: model.Libraries{{ID: 1, Name: "Lib 1"}},
		}
		getReq := httptest.NewRequest(http.MethodGet, "/site/room?device=dev-guest", nil)
		getReq = getReq.WithContext(request.WithUser(getReq.Context(), restricted))
		getRec := httptest.NewRecorder()
		srv.getRoom(getRec, getReq)
		Expect(getRec.Code).To(Equal(http.StatusOK))

		var restrictedPayload struct {
			Queue []roomEntry `json:"queue"`
		}
		Expect(json.Unmarshal(getRec.Body.Bytes(), &restrictedPayload)).To(Succeed())
		Expect(restrictedPayload.Queue).To(HaveLen(2))
		Expect(restrictedPayload.Queue[0].Album).To(Equal("Debut Album"))
		Expect(restrictedPayload.Queue[1].Unavailable).To(BeTrue())
		Expect(restrictedPayload.Queue[1].Album).To(BeEmpty())
		Expect(restrictedPayload.Queue[1].Year).To(BeZero())
	})

	It("supports room broadcast announcements with validation and rate limiting", func() {
		// 未加入房间不能广播
		unjoinedRec := postRoom(admin, map[string]any{
			"action":  "announce",
			"device":  "dev-admin",
			"session": "test-session",
			"message": "快来一起听",
		})
		Expect(unjoinedRec.Code).To(Equal(http.StatusForbidden))

		Expect(postRoom(admin, map[string]any{
			"action": "join",
			"device": "dev-admin",
		}).Code).To(Equal(http.StatusOK))

		// 空消息被拒绝
		emptyRec := postRoom(admin, map[string]any{
			"action":  "announce",
			"device":  "dev-admin",
			"session": "test-session",
			"message": "   ",
		})
		Expect(emptyRec.Code).To(Equal(http.StatusBadRequest))

		// 正常发送广播，且不改变队列 Version
		okRec := postRoom(admin, map[string]any{
			"action":  "announce",
			"device":  "dev-admin",
			"session": "test-session",
			"message": "一起来听新专辑",
		})
		Expect(okRec.Code).To(Equal(http.StatusOK))

		var payload struct {
			Version      int64             `json:"version"`
			Announcement *roomAnnouncement `json:"announcement"`
		}
		Expect(json.Unmarshal(okRec.Body.Bytes(), &payload)).To(Succeed())
		Expect(payload.Version).To(Equal(int64(0)))
		Expect(payload.Announcement).ToNot(BeNil())
		Expect(payload.Announcement.ID).To(Equal(int64(1)))
		Expect(payload.Announcement.UserID).To(Equal("u-admin"))
		Expect(payload.Announcement.UserName).To(Equal("Admin"))
		Expect(payload.Announcement.Message).To(Equal("一起来听新专辑"))

		// 3 秒冷却期内重复发送被限流
		rateRec := postRoom(admin, map[string]any{
			"action":  "announce",
			"device":  "dev-admin",
			"session": "test-session",
			"message": "再次提醒",
		})
		Expect(rateRec.Code).To(Equal(http.StatusTooManyRequests))

		// 全员退出后清空广播，防止新进入的旁观者收到过期邀请
		Expect(postRoom(admin, map[string]any{
			"action": "leave",
			"device": "dev-admin",
		}).Code).To(Equal(http.StatusNoContent))

		getReq := httptest.NewRequest(http.MethodGet, "/site/room", nil)
		getReq = getReq.WithContext(request.WithUser(getReq.Context(), admin))
		getRec := httptest.NewRecorder()
		srv.getRoom(getRec, getReq)
		Expect(getRec.Code).To(Equal(http.StatusOK))
		var afterLeave struct {
			Announcement *roomAnnouncement `json:"announcement"`
		}
		Expect(json.Unmarshal(getRec.Body.Bytes(), &afterLeave)).To(Succeed())
		Expect(afterLeave.Announcement).To(BeNil())
	})
})
