Answers recorded from the live services on 2026-10-10 from the dev box, unmodified except that the arXiv page is gzip-compressed:

semantic-scholar-batch.json     POST https://api.semanticscholar.org/graph/v1/paper/batch?fields=title,venue,publicationVenue,publicationDate,citationCount,influentialCitationCount,externalIds,openAccessPdf
                                ids ARXIV:2610.12083, ARXIV:2610.12453, ARXIV:2506.00001 (keyless; the platform sends its key in x-api-key)
openalex-work-preprint.json     GET https://api.openalex.org/works/doi:10.48550/arxiv.2506.00001?select=id,doi,title,cited_by_count,publication_date,type,primary_location,locations
openalex-work-published.json    GET https://api.openalex.org/works/doi:10.48550/arxiv.2005.14165?select=... (a preprint with a conference version among its locations)
arxiv-html-2610.11959.html.gz   GET https://arxiv.org/html/2610.11959 (a paper with no author e-mail addresses)
openalex-invalid-key.json         GET https://api.openalex.org/works/doi:10.48550/arxiv.2506.00001?select=id with 'Authorization: Bearer not-a-real-key' -> 401 (the same answer to an api_key parameter)
