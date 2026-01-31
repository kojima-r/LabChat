from typing import List, TypedDict, Annotated
from typing_extensions import TypedDict, Literal
from pydantic import Field
from crossref.restful import Journals, Works
from fastmcp import FastMCP

# initialize mcp instance
mcp = FastMCP(name="reference-search")
    
# returns type
class Article(TypedDict):
    title: Annotated[str, Field(description="論文のタイトル")]
    doi: Annotated[str, Field(description="論文のDOIリンク")]
    journal: Annotated[str, Field(description="掲載されているジャーナル")]
    year: Annotated[int, Field(description="掲載年")]
    score: Annotated[float, Field(description="検索クエリと論文の関連度")]
    cited_count: Annotated[int, Field(description="論文が引用された回数")]

@mcp.tool()
async def search_articles(
    keywords: Annotated[str, Field(description="部分一致検索したいキーワード")],
    criterion: Annotated[Literal["year", "score", "cited_count"], Field(description="結果をソートする基準")] = "score",
    nhits: Annotated[int, Field(description="表示件数")] = 10,
) -> List[Article]:
    """キーワードをもとに論文を検索"""
    # issn numbers
    issns = [
        "1476-4687",   # Nature
        "1095-9203",   # Science
        "2041-1723",   # Nature Communications
    ]
    
    # search articles
    works = Works()
    all_articles = []
    for issn in issns:
        hits = works.filter(issn=issn).query(bibliographic=keywords)

        articles = [{
            "title": item.get("title")[0] or None,
            "doi": item.get("URL") or None,
            "journal": item.get("container-title")[0] or None,
            "year": item.get("published").get("date-parts")[0][0] or 0,
            "score": item.get("score") or 0,
            "cited_count": item.get("is-referenced-by-count") or 0,
        } for item in hits]
        
        all_articles += articles
        
    # sort
    all_articles.sort(key=lambda a: -a.get(criterion))
    
    return all_articles[:nhits]

if __name__ == "__main__":
    mcp.run(transport="stdio")

