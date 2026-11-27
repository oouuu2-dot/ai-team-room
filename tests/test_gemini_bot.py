import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).resolve().parents[1]/'gemini_bot.py')
bot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bot)

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = patch.object(bot,'STATE_PATH',Path(self.temp.name)/'state.json')
        self.path.start()
        self.addCleanup(self.path.stop)

    def test_explicit_aliases_not_status_mentions(self):
        for text in ['@Gemini 확인','@재미 확인','@재미나이 확인','@클로드 @Gemini 협업','[Gemini] 확인']:
            self.assertTrue(bot.calls_gemini(text),text)
        for text in ['Gemini 봇 원인 보고','사용법: @Gemini로 호출','@재미없는봇']:
            self.assertFalse(bot.calls_gemini(text),text)

    def test_old_requests_survive_failure_and_are_deduplicated_on_retry(self):
        state=bot.load_state()
        old={'id':1500,'sender':'뮤즈','content':'@Gemini 확인','created_at':'2026-11-01T00:00:00Z'}
        def get(room,key,after,limit=50):
            return [old] if room=='general' and after<1500 else []
        with patch.object(bot,'room_get',side_effect=get),patch.object(bot,'validate_model'),patch.object(bot,'gemini_reply',side_effect=bot.BridgeError('Gemini generate HTTP 429')):
            self.assertEqual(bot.run(state,'room-secret','model-secret'),1)
        state=bot.load_state()
        self.assertEqual(state['pending'],[{'room':'general','id':1500}])
        with patch.object(bot,'room_get',side_effect=get),patch.object(bot,'validate_model'),patch.object(bot,'gemini_reply',return_value='확인'),patch.object(bot,'room_post',return_value={'message':{'id':1600}}) as post:
            self.assertEqual(bot.run(state,'room-secret','model-secret'),0)
            self.assertEqual(bot.run(state,'room-secret','model-secret'),0)
            self.assertEqual(post.call_count,1)
        self.assertFalse(state['pending'])

    def test_existing_reply_recovers_ambiguous_delivery(self):
        state=bot.load_state()
        state['pending']=[{'room':'general','id':1500}]
        def get(room,key,after,limit=50):
            return [{'id':1501,'sender':'Gemini','reply_to_id':1500,'content':'확인'}] if room=='general' and after<1501 else []
        with patch.object(bot,'room_get',side_effect=get):
            self.assertEqual(bot.scan(state,'test'),[])
        self.assertEqual(state['pending'],[])

    def test_credentials_use_headers_and_failures_do_not_echo_request_urls(self):
        class Response:
            ok=False
            status_code=403
        with patch.object(bot.requests,'get',return_value=Response()) as get:
            with self.assertRaisesRegex(bot.BridgeError,'room read HTTP 403'):
                bot.room_get('general','private-room-key',1400)
            kwargs=get.call_args.kwargs
            self.assertNotIn('key',kwargs['params'])
            self.assertEqual(kwargs['headers']['Authorization'],'Bearer private-room-key')
        with patch.object(bot.requests,'get',return_value=Response()):
            with self.assertRaisesRegex(bot.BridgeError,'Gemini model list HTTP 403'):
                bot.validate_model('private-google-key')

    def test_key_model_check_runs_even_without_calls(self):
        with patch.object(bot,'room_get',return_value=[]),patch.object(bot,'validate_model',side_effect=bot.BridgeError('configured Gemini model unavailable')):
            with self.assertRaises(bot.BridgeError):
                bot.run(bot.load_state(),'test-room','test-google')
        self.assertTrue(bot.STATE_PATH.exists())

if __name__=='__main__':
    unittest.main()
