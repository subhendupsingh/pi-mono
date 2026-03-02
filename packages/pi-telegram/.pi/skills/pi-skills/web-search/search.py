import requests
import json
import sys

query = sys.argv[1]
url = "http://searxng-a8cgcsg8wcwg8csc04c8ks0w.65.109.1.92.sslip.io/search"
params = {"q": query, "format": "json", "pageno": 1}
r = requests.get(url, params=params, timeout=10)
data = r.json()
# data.keys() typically: ['query', 'number_of_results', 'results', ...]
results = data.get("results", [])[:10]
print(json.dumps([{
    "title": res["title"],
    "url": res["url"],
    "content": res.get("content", "")
} for res in results]))