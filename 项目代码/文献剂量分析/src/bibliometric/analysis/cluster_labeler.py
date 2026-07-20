# [IN] cluster dict {cluster_id: [terms]}, articles list
# [OUT] dict of cluster labels {cluster_id: {en_label, cn_label, category}}
# [POS] src/bibliometric/analysis/cluster_labeler.py - cluster naming

from __future__ import annotations

import logging
import re
from collections import Counter

from sklearn.feature_extraction.text import TfidfVectorizer

logger = logging.getLogger(__name__)

# Non-informative words to exclude from cluster labels
LABEL_STOPWORDS = {
    "like", "and", "the", "with", "type", "role", "effect", "study",
    "using", "based", "related", "associated", "between", "among",
    "from", "into", "through", "during", "after", "before",
    "analysis", "review", "research", "report", "case", "use",
    "new", "novel", "recent", "current", "various", "different",
}

# Category patterns for rule-based classification
CATEGORY_PATTERNS = {
    "mechanism": [
        "mechanism", "pathway", "signaling", "receptor", "gene",
        "expression", "regulation", "molecular", "cellular", "protein",
        "apoptosis", "inflammation", "oxidative",
    ],
    "diagnosis": [
        "diagnosis", "diagnostic", "biomarker", "screening", "detection",
        "imaging", "sensitivity", "specificity", "accuracy", "prediction",
        "MRI", "CT", "ultrasound", "biopsy",
    ],
    "therapy": [
        "treatment", "therapy", "therapeutic", "efficacy", "drug",
        "surgery", "chemotherapy", "immunotherapy", "intervention",
        "clinical trial", "dose", "response", "survival",
    ],
    "safety": [
        "safety", "adverse", "toxicity", "side effect", "complication",
        "risk", "mortality", "morbidity", "contraindication",
    ],
    "epidemiology": [
        "prevalence", "incidence", "epidemiology", "population",
        "cohort", "risk factor", "odds ratio", "association",
        "cross-sectional", "longitudinal",
    ],
    "implementation": [
        "guideline", "policy", "implementation", "cost", "effectiveness",
        "quality", "standard", "protocol", "management", "care",
        "healthcare", "system",
    ],
}


def label_clusters(
    clusters: dict[int, list[str]],
    articles: list[dict],
) -> dict[int, dict]:
    """Generate labels for each cluster."""
    if not clusters:
        return {}

    labels = {}
    for cluster_id, terms in clusters.items():
        label = _label_single_cluster(cluster_id, terms, articles)
        labels[cluster_id] = label

    logger.info("Labeled %d clusters", len(labels))
    return labels


def _label_single_cluster(
    cluster_id: int,
    terms: list[str],
    articles: list[dict],
) -> dict:
    """Generate label for a single cluster."""
    top_terms = _get_top_tfidf_terms(terms, articles)
    category = _classify_category(terms)
    en_label = _generate_en_label(top_terms, category)

    return {
        "cluster_id": cluster_id,
        "en_label": en_label,
        "category": category,
        "top_terms": top_terms[:5],
        "size": len(terms),
    }


def _get_top_tfidf_terms(
    cluster_terms: list[str],
    articles: list[dict],
    top_n: int = 5,
) -> list[str]:
    """Extract top terms from cluster using TF-IDF."""
    if not cluster_terms:
        return []

    cluster_set = set(t.lower() for t in cluster_terms)

    cluster_docs = []
    other_docs = []
    for art in articles:
        kws = art.get("keywords_merged", [])
        kw_lower = set(k.lower() for k in kws)
        text = " ".join(kws)
        if kw_lower & cluster_set:
            cluster_docs.append(text)
        else:
            other_docs.append(text)

    if not cluster_docs:
        freq = Counter(cluster_terms)
        return [t for t, _ in freq.most_common(top_n)]

    all_docs = cluster_docs + other_docs
    if len(all_docs) < 2:
        freq = Counter(cluster_terms)
        return [t for t, _ in freq.most_common(top_n)]

    try:
        vectorizer = TfidfVectorizer(max_features=500)
        tfidf = vectorizer.fit_transform(all_docs)
        feature_names = vectorizer.get_feature_names_out()

        cluster_tfidf = tfidf[: len(cluster_docs)].mean(axis=0).A1
        top_indices = cluster_tfidf.argsort()[::-1]

        # Filter out stopwords and short terms
        filtered = []
        for i in top_indices:
            term = feature_names[i]
            if len(term) > 2 and term.lower() not in LABEL_STOPWORDS:
                filtered.append(term)
            if len(filtered) >= top_n:
                break
        return filtered if filtered else [feature_names[top_indices[0]]]
    except Exception:
        freq = Counter(cluster_terms)
        return [t for t, _ in freq.most_common(top_n)
                if len(t) > 2 and t.lower() not in LABEL_STOPWORDS][:top_n]


def _classify_category(terms: list[str]) -> str:
    """Classify cluster into a research category using word-boundary matching."""
    terms_lower = " ".join(t.lower() for t in terms)
    scores = {}
    for category, patterns in CATEGORY_PATTERNS.items():
        score = sum(
            1 for p in patterns
            if re.search(rf"\b{re.escape(p.lower())}\b", terms_lower)
        )
        scores[category] = score

    if max(scores.values(), default=0) == 0:
        return "general"
    return max(scores, key=scores.get)


def _generate_en_label(top_terms: list[str], category: str = "general") -> str:
    """Generate English label from top terms and category.

    Uses concise 'Category: Term1, Term2, Term3' format.
    """
    if not top_terms:
        return "Unnamed Cluster"

    CATEGORY_PREFIXES = {
        "mechanism": "Mechanisms",
        "diagnosis": "Diagnostics",
        "therapy": "Therapeutics",
        "safety": "Safety",
        "epidemiology": "Epidemiology",
        "implementation": "Implementation",
        "general": "Research",
    }
    prefix = CATEGORY_PREFIXES.get(category, "Research")
    # Filter stopwords from label terms
    meaningful = [t for t in top_terms if t.lower() not in LABEL_STOPWORDS and len(t) > 2]
    if not meaningful:
        meaningful = top_terms[:3]
    key_terms = ", ".join(t.title() for t in meaningful[:3])
    return f"{prefix}: {key_terms}"
