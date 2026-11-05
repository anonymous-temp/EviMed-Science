"""Fresh-output path contract, using fabricated records and no network."""
import csv, io, json, os, pathlib, subprocess, sys, tarfile, tempfile, unittest
HERE = pathlib.Path(__file__).resolve().parent
class PathsTest(unittest.TestCase):
 def test_separate_input_and_output(self):
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t); raw=root/'raw elsewhere'; out=root/'fresh output'; raw.mkdir(); out.mkdir()
   env={**os.environ,'VCR_EVAL_RAW_DIR':str(raw),'VCR_EVAL_OUTPUT':str(out)}
   shown=json.loads(subprocess.check_output([sys.executable,str(HERE/'prepare.py'),'--show-paths'],env=env,text=True))
   self.assertEqual(pathlib.Path(shown['input']),raw.resolve());self.assertEqual(pathlib.Path(shown['output']),out.resolve())
   content=b'Time,Parameter,Value\n00:00,HR,80\n24:00,HR,90\n'
   for split in 'abc':
    with tarfile.open(raw/f'set-{split}.tar.gz','w:gz') as tar:
     info=tarfile.TarInfo(f'{split}1.txt');info.size=len(content);tar.addfile(info,io.BytesIO(content))
   subprocess.run([sys.executable,str(HERE/'hr_baseline.py')],env=env,check=True,capture_output=True)
   self.assertEqual(json.loads((out/'hr-baseline.json').read_text())['splits']['b']['scored'],1)
   self.assertTrue((out/'hr-b-paired.csv').exists());self.assertFalse((raw/'hr-baseline.json').exists())
   for split in 'bc':
    with (out/f'hr-{split}-paired.csv').open('w',newline='') as f:
     w=csv.writer(f);w.writerow(['USUBJID','hr_early','hr_24']);w.writerows((str(i),70+i,75+i) for i in range(20))
    directory=out/f'hr-pred-{split}';directory.mkdir()
    with (directory/'prognostic-predictions.csv').open('w',newline='') as f:
     w=csv.writer(f);w.writerow(['patientId','prediction']);w.writerows((str(i),74+i) for i in range(20))
   subprocess.run([sys.executable,str(HERE/'hr_uncertainty.py')],env=env,check=True,capture_output=True)
   self.assertTrue((out/'hr-uncertainty.json').exists());self.assertFalse((raw/'hr-uncertainty.json').exists())
 def test_encoding_validator_reads_each_copy_at_exact_precision(self):
  with tempfile.TemporaryDirectory() as t:
   p=pathlib.Path(t);(p/'full-engine-output').mkdir()
   (p/'preprocessing.json').write_text(json.dumps({'recipe':{'x':{'missingIndicator':True}}}))
   (p/'engine_train.csv').write_text('x,x_missing\n2.1333333333333333,1\n4,0\n')
   target=p/'full-engine-output'/'synthetic-population.csv'
   target.write_text('copy,x,x_missing\n1,2.1333333333333333,1\n2,2.13333333333333,1\n')
   subprocess.run([sys.executable,str(HERE/'validate_encodings.py')],env={**os.environ,'VCR_EVAL_OUTPUT':str(p)},check=True,capture_output=True)
   report=json.loads((p/'encoding-validation.json').read_text())
   self.assertEqual(report['violationsByCopy'],{'1':0,'2':1})
 def test_fresh_download_directory_is_created_offline(self):
  with tempfile.TemporaryDirectory() as t:
   dest=pathlib.Path(t)/'new'/'cran'/'src'/'contrib'
   env={**os.environ,'VCR_EVAL_CRAN_DIR':str(dest)}
   subprocess.run([sys.executable,str(HERE/'download_locked_packages.py'),'--prepare-only'],env=env,check=True,capture_output=True)
   self.assertTrue(dest.is_dir())
if __name__=='__main__': unittest.main()
