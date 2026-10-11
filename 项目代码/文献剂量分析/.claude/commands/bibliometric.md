Run a complete AI-driven bibliometric analysis on a PubMed research topic.

Execute the following command:

```bash
cd 项目代码/文献剂量分析   # from the repository root
source .venv/bin/activate
PYTHONPATH=src python3 -m bibliometric analyze $ARGUMENTS
```

If venv doesn't exist, create it first:

```bash
cd 项目代码/文献剂量分析   # from the repository root
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
PYTHONPATH=src python3 -m bibliometric analyze $ARGUMENTS
```

After running, show the report path and a summary of generated files.
