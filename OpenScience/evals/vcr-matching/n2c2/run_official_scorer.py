"""Run the official n2c2 2018 Track 1 scorer, unchanged, on a gold folder and a system folder.

The scorer imports `xml.etree.cElementTree`, which Python removed in 3.9. This wrapper puts the maintained module under that
name and then runs the scorer's own file as the main program, so the numbers are the scorer's and the file is not edited.

    python3 -I run_official_scorer.py <track1_eval.py> <gold-folder> <system-folder>
"""
import runpy
import sys
import xml.etree
import xml.etree.ElementTree as ElementTree

sys.modules.setdefault("xml.etree.cElementTree", ElementTree)
xml.etree.cElementTree = ElementTree

if len(sys.argv) != 4:
    sys.exit("usage: run_official_scorer.py <track1_eval.py> <gold-folder> <system-folder>")
script, gold, system = sys.argv[1:]
sys.argv = [script, gold, system]
runpy.run_path(script, run_name="__main__")
