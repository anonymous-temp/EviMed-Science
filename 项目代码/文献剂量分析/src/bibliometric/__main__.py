# [IN] sys.path setup
# [OUT] bibliometric package accessible via `python -m bibliometric`
# [POS] src/bibliometric/__main__.py - package entry point

from bibliometric.cli import main

if __name__ == "__main__":
    main()
