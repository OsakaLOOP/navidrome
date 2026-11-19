package server

import (
	"net/http"
	"net/http/httptest"

	"github.com/navidrome/navidrome/conf"
	"github.com/navidrome/navidrome/conf/configtest"
	"github.com/navidrome/navidrome/consts"
	"github.com/navidrome/navidrome/tests"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("UI trailing slash redirect", func() {
	var srv *Server

	BeforeEach(func() {
		DeferCleanup(configtest.SetupConfig())
		ds := &tests.MockDataStore{MockedUser: &mockedUserRepo{}}
		srv = New(ds, nil, nil)
		srv.MountRouter("WebUI", consts.URLPathUI, srv.frontendAssetsHandler())
		srv.MountRouter("Music", "/music", srv.musicAssetsHandler())
	})

	It("redirects /music without trailing slash to /music/ while preserving query", func() {
		req := httptest.NewRequest(http.MethodGet, "/music?code=abc", nil)
		rec := httptest.NewRecorder()
		srv.router.ServeHTTP(rec, req)

		Expect(rec.Code).To(Equal(http.StatusFound))
		Expect(rec.Header().Get("Location")).To(Equal("/music/?code=abc"))
		Expect(rec.Header().Get("Cache-Control")).To(Equal("no-store"))
	})

	It("serves music index.html and settings.js under /music/", func() {
		req := httptest.NewRequest(http.MethodGet, "/music/", nil)
		rec := httptest.NewRecorder()
		srv.router.ServeHTTP(rec, req)

		Expect(rec.Code).To(Equal(http.StatusOK))
		Expect(rec.Header().Get("Content-Type")).To(ContainSubstring("text/html"))
		Expect(rec.Body.String()).To(ContainSubstring("settings.js"))

		settingsReq := httptest.NewRequest(http.MethodGet, "/music/settings.js", nil)
		settingsRec := httptest.NewRecorder()
		srv.router.ServeHTTP(settingsRec, settingsReq)

		Expect(settingsRec.Code).To(Equal(http.StatusOK))
		Expect(settingsRec.Header().Get("Content-Type")).To(ContainSubstring("application/javascript"))
	})

	It("redirects /app without trailing slash to /app/", func() {
		req := httptest.NewRequest(http.MethodGet, "/app", nil)
		rec := httptest.NewRecorder()
		srv.router.ServeHTTP(rec, req)

		Expect(rec.Code).To(Equal(http.StatusFound))
		Expect(rec.Header().Get("Location")).To(Equal("/app/"))
	})

	It("respects BasePath for /music redirect", func() {
		conf.Server.BasePath = "/nd"
		ds := &tests.MockDataStore{MockedUser: &mockedUserRepo{}}
		baseSrv := New(ds, nil, nil)
		baseSrv.MountRouter("Music", "/music", baseSrv.musicAssetsHandler())

		req := httptest.NewRequest(http.MethodGet, "/nd/music", nil)
		rec := httptest.NewRecorder()
		baseSrv.router.ServeHTTP(rec, req)

		Expect(rec.Code).To(Equal(http.StatusFound))
		Expect(rec.Header().Get("Location")).To(Equal("/nd/music/"))
	})
})
