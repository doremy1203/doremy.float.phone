import unittest
from unittest.mock import patch

import server


class FormatSelectionTests(unittest.TestCase):
    def test_prefers_h264_when_ffmpeg_available(self):
        with patch.object(server.shutil, "which", return_value="/usr/bin/ffmpeg"):
            options = server.ydl_options("/tmp/video.%(ext)s", "720")
        self.assertIn("vcodec^=avc1", options["format"])
        self.assertIn("height<=720", options["format"])

    def test_merges_audio_when_ffmpeg_available(self):
        with patch.object(server.shutil, "which", return_value="/usr/bin/ffmpeg"):
            options = server.ydl_options("/tmp/video.%(ext)s", "best")
        self.assertEqual(options["merge_output_format"], "mp4")
        self.assertIn("bestaudio", options["format"])

    def test_single_file_fallback_without_ffmpeg(self):
        with patch.object(server.shutil, "which", return_value=None):
            options = server.ydl_options("/tmp/video.%(ext)s", "720")
        self.assertEqual(options["format"], "best[height<=720][vcodec^=avc1]/best[height<=720]/best")


class UrlGuardTests(unittest.TestCase):
    def test_rejects_non_http_scheme(self):
        with self.assertRaises(server.HttpError) as ctx:
            server.validate_url("ftp://example.com/v.mp4")
        self.assertEqual(ctx.exception.status, 400)

    def test_rejects_loopback_and_private(self):
        for url in ("http://127.0.0.1/v.mp4", "http://localhost/v.mp4", "http://192.168.1.10/v.mp4"):
            with self.assertRaises(server.HttpError):
                server.validate_url(url)

    def test_allows_proxy_fake_ip_range(self):
        # 手机代理的 Fake-IP 段（RFC2544）实际映射公网域名，不能当成内网拒绝。
        with patch.object(server.socket, "getaddrinfo", return_value=[(None, None, None, None, ("198.18.0.13", 443))]):
            self.assertEqual(server.validate_url("https://www.bilibili.com/video/BV1xx411c7mD"),
                             "https://www.bilibili.com/video/BV1xx411c7mD")

    def test_rejects_unresolvable_host(self):
        with patch.object(server.socket, "getaddrinfo", side_effect=OSError("dns fail")):
            with self.assertRaises(server.HttpError):
                server.validate_url("https://nonexistent.invalid/v.mp4")


class XiaohongshuTests(unittest.TestCase):
    PAGE = (
        '<html><head><meta name="og:title" content="深夜食堂探店_小红书"></head><body>'
        '<script>window.__INITIAL_STATE__={"note":{"video":{"media":{"stream":{"h264":[{"masterUrl":"https:\\/\\/sns-video-bd.xhscdn.com\\/abc.mp4"}]}}}}}}</script>'
        '</body></html>'
    )

    def test_extracts_master_url_and_title(self):
        direct, title = server._xhs_master_url(self.PAGE)
        self.assertEqual(direct, "https://sns-video-bd.xhscdn.com/abc.mp4")
        self.assertEqual(title, "深夜食堂探店")

    def test_image_note_is_reported_clearly(self):
        with self.assertRaises(server.HttpError) as ctx:
            server._xhs_master_url('<html>{"imageList":[{"url":"x"}]}</html>')
        self.assertEqual(ctx.exception.status, 422)
        self.assertIn("图文笔记", ctx.exception.detail)

    def test_cookie_header_only_keeps_xiaohongshu_cookies(self):
        cookies = (
            "# Netscape HTTP Cookie File\n"
            ".xiaohongshu.com\tTRUE\t/\tFALSE\t0\ta1\tweb_session\n"
            ".douyin.com\tTRUE\t/\tFALSE\t0\tsid\txyz\n"
        )
        self.assertEqual(server._xhs_cookie_header(cookies), "a1=web_session")


class _FakeResponse:
    def __init__(self, url, body):
        self._url, self._body = url, body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def geturl(self):
        return self._url

    def read(self):
        return self._body.encode()


class XhsPageTests(unittest.TestCase):
    def test_xsec_token_in_url_is_not_a_security_page(self):
        # 回归：早期实现用 `"sec_" in final_url` 判断安全页，把正常链接里的
        # xsec_token 也命中了，导致所有带 token 的笔记都被误判成「打不开」。
        url = "https://www.xiaohongshu.com/discovery/item/abc?xsec_token=XYZ"
        with patch.object(server, "urlopen", return_value=_FakeResponse(url, XiaohongshuTests.PAGE)):
            html = server._xhs_page(url, "")
        self.assertIn("masterUrl", html)

    def test_login_wall_reports_actionable_error(self):
        url = "https://www.xiaohongshu.com/login?redirectPath=%2Fdiscovery%2Fitem%2Fabc"
        with patch.object(server, "urlopen", return_value=_FakeResponse(url, "<html></html>")):
            with self.assertRaises(server.HttpError) as ctx:
                server._xhs_page("https://www.xiaohongshu.com/discovery/item/abc", "")
        self.assertIn("Cookies", ctx.exception.detail)


if __name__ == "__main__":
    unittest.main()
