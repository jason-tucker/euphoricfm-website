"""check_info: the data-only checks on yt-dlp's info JSON (no subprocess)."""

import unittest

from fetchsvc.errors import EXTRACTOR_FAILED, NOT_A_TRACK, PREVIEW_ONLY, TOO_LONG, FetchError
from fetchsvc.service import MAX_DURATION_S, check_info


def info(**over):
    base = {'_type': 'video', 'extractor': 'soundcloud', 'extractor_key': 'Soundcloud',
            'duration': 240.0, 'format_id': 'hls_aac_160k'}
    base.update(over)
    return {k: v for k, v in base.items() if v is not None}


class CheckInfoTests(unittest.TestCase):
    def code(self, doc):
        with self.assertRaises(FetchError) as cm:
            check_info(doc, MAX_DURATION_S)
        return cm.exception.code

    def test_a_full_track_passes(self):
        for fid in ('hls_aac_160k', 'http_mp3_128', 'hls_opus_64k', None):
            with self.subTest(format_id=fid):
                check_info(info(format_id=fid), MAX_DURATION_S)
        check_info(info(snipped=False), MAX_DURATION_S)

    def test_preview_only_formats_are_refused(self):
        # yt-dlp 2026.8.19 names a preview transcoding <protocol>_<preset>_preview
        # (extractor/soundcloud.py), and SoundCloud marks it `snipped`.
        for fid in ('hls_aac_160k_preview', 'http_mp3_128_preview', 'hls_opus_64k_preview', 'HLS_AAC_PREVIEW'):
            with self.subTest(format_id=fid):
                self.assertEqual(self.code(info(format_id=fid)), PREVIEW_ONLY)
        self.assertEqual(self.code(info(snipped=True)), PREVIEW_ONLY)

    def test_preview_is_decided_before_the_duration(self):
        # A preview of a 30-min track is still reported as a preview.
        self.assertEqual(self.code(info(format_id='hls_aac_160k_preview', duration=1800)), PREVIEW_ONLY)

    def test_non_string_format_id_is_ignored(self):
        check_info(info(format_id=12), MAX_DURATION_S)
        check_info(info(snipped='yes'), MAX_DURATION_S)  # only a real JSON true counts

    def test_the_other_checks_still_apply(self):
        self.assertEqual(self.code(info(_type='playlist')), NOT_A_TRACK)
        self.assertEqual(self.code(info(extractor='generic')), NOT_A_TRACK)
        self.assertEqual(self.code(info(duration=None)), EXTRACTOR_FAILED)
        self.assertEqual(self.code(info(duration=MAX_DURATION_S + 1)), TOO_LONG)


if __name__ == '__main__':
    unittest.main()
