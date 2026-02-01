import arxiv
import sys
import logging

logger = logging.getLogger(__name__)

def search_arxiv(query: str, max_results: int = 5) -> str:
    logger.info(f"arXiv search start: query='{query}'")

    search = arxiv.Search(
        query=query,
        max_results=max_results,
        sort_by=arxiv.SortCriterion.Relevance
    )

    papers = []
    for paper in search.results():
        papers.append(
            f"""
タイトル: {paper.title}
著者: {', '.join(a.name for a in paper.authors)}
要約: {paper.summary.strip()}
URL: {paper.entry_id}
"""
        )
    logger.info(f"found {len(papers)} papers")
    return "\n---\n".join(papers)

