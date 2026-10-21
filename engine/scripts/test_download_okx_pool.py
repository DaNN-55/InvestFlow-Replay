"""Offline integrity/resumption tests for P6 public evidence acquisition."""
import importlib.util
import gzip
import json
from pathlib import Path
import tempfile
import unittest
from datetime import datetime,timezone,timedelta
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('okx_pool_download',Path(__file__).with_name('download_okx_pool.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class PoolDownloadTests(unittest.TestCase):
 def test_plan_has_full_leap_year_days_and_one_terminal_minute(self):
  start=datetime(2023,10,3,tzinfo=module.BJT);end=datetime(2026,1,1,0,1,tzinfo=module.BJT);jobs=module.jobs_for(start,end)
  for inst in module.INST:
   for kind in ['last','mark']:
    blocks=sorted([j for j in jobs if j['instrumentId']==inst and j['kind']==kind and j['bar']=='1m'],key=lambda j:j['start'])
    self.assertEqual(len(blocks),822);self.assertEqual(sum((j['endExclusive']-j['start'])//module.M for j in blocks),821*1440+1)
    self.assertEqual(blocks[-1]['endExclusive']-blocks[-1]['start'],module.M)
    self.assertTrue(all(a['endExclusive']==b['start'] for a,b in zip(blocks,blocks[1:])))
 def test_cached_page_and_file_hashes_reject_corruption_without_network(self):
  with tempfile.TemporaryDirectory() as t:
   raw=Path(t)/'raw';seed=Path(t)/'seed';raw.mkdir();seed.mkdir()
   j=module.jobs_for(datetime(2024,1,1,tzinfo=module.BJT),datetime(2024,1,1,0,1,tzinfo=module.BJT))[0]
   response='{"code":"0","data":[]}';page={'responseText':response,'responseSHA256':module.sha(response.encode())}
   path=raw/(j['key']+'.json.gz');data=gzip.compress(json.dumps({'job':j,'pages':[page]}).encode());path.write_bytes(data)
   with patch.object(module,'fetch',side_effect=AssertionError('must not fetch')):
    info=module.candles(j,raw,seed);self.assertEqual(info['sha256'],module.sha(data))
    altered=gzip.compress(json.dumps({'job':j,'pages':[{**page,'responseText':'corrupt'}]}).encode());path.write_bytes(altered)
    with self.assertRaisesRegex(ValueError,'hash changed'):module.candles(j,raw,seed)
    path.with_suffix('.source.json').unlink()
    with self.assertRaisesRegex(ValueError,'response corrupt'):module.candles(j,raw,seed)
 def test_seed_reuse_preserves_original_request_limit_and_source_bytes(self):
  with tempfile.TemporaryDirectory() as t:
   raw=Path(t)/'raw';seed=Path(t)/'seed';raw.mkdir();seed.mkdir()
   j=module.jobs_for(datetime(2024,1,1,tzinfo=module.BJT),datetime(2024,1,1,0,1,tzinfo=module.BJT))[0];old={**j,'limit':100}
   response='{"code":"0","data":[]}';data=gzip.compress(json.dumps({'job':old,'pages':[{'responseText':response,'responseSHA256':module.sha(response.encode())}]}).encode());(seed/(j['key']+'.json.gz')).write_bytes(data)
   with patch.object(module,'fetch',side_effect=AssertionError('must not fetch')):
    info=module.candles(j,raw,seed);self.assertEqual(info['limit'],100);self.assertEqual((raw/info['file']).read_bytes(),data)
if __name__=='__main__':unittest.main()
