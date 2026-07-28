from playwright.sync_api import sync_playwright

urls = [
    "https://sanand0.github.io/tdsdata/js_table/?seed=16",
    "http://sanand0.github.io/tdsdata/js_table/?seed=17",
    "https://sanand0.github.io/tdsdata/js_table/?seed=18",
    "https://sanand0.github.io/tdsdata/js_table/?seed=19",
    "https://sanand0.github.io/tdsdata/js_table/?seed=20",
    "https://sanand0.github.io/tdsdata/js_table/?seed=21",
    "https://sanand0.github.io/tdsdata/js_table/?seed=22",
    "https://sanand0.github.io/tdsdata/js_table/?seed=23",
    "https://sanand0.github.io/tdsdata/js_table/?seed=24",
    "https://sanand0.github.io/tdsdata/js_table/?seed=25",
]

total_sum = 0

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    for url in urls:
        print(f"Processing {url}")
        page.goto(url)
        
        try:
            page.wait_for_selector('table td', timeout=5000)
            page.wait_for_timeout(1000)
        except Exception as e:
            print(f"Error waiting for table on {url}: {e}")

        tds = page.locator('td').all_text_contents()
        for td in tds:
            try:
                total_sum += float(td.strip())
            except ValueError:
                pass
                
    browser.close()

print(f"Total sum: {total_sum}")
