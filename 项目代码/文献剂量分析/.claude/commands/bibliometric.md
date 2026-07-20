Run a complete AI-driven bibliometric analysis on a PubMed research topic.

Execute the following command:

```bash
cd /Users/wangzeyuan/Desktop/文献计量分析
source venv/bin/activate
PYTHONPATH=src python3 -m bibliometric analyze $ARGUMENTS
```

If venv doesn't exist, create it first:

```bash
cd /Users/wangzeyuan/Desktop/文献计量分析
python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt
PYTHONPATH=src python3 -m bibliometric analyze $ARGUMENTS
```

After running, show the report path and a summary of generated files.
