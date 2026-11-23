# Third-party notices

Helm's own code is MIT-licensed (see [LICENSE](LICENSE)). LEAN and the Python packages below are not part of this repository: they are downloaded during installation and keep their own licenses. The last section credits work that Helm's deck feature adapts.

## QuantConnect LEAN

The backtesting engine. `scripts/setup.sh` downloads a pinned commit from https://github.com/QuantConnect/Lean into `engine/Lean` and builds it locally. Not redistributed in this repository.

License: Apache License 2.0. Copyright QuantConnect Corporation. Full text: https://github.com/QuantConnect/Lean/blob/master/LICENSE

## yfinance

Python library used to download prices (`engine/fetch_data.py`, the qlib research engine). Installed into `engine/.venv` from PyPI (`engine/requirements.txt`). Not redistributed.

License: Apache License 2.0. Copyright Ran Aroussi. Full text: https://github.com/ranaroussi/yfinance/blob/main/LICENSE.txt

**Yahoo Finance data.** Prices fetched through yfinance come from Yahoo Finance. yfinance is not affiliated with Yahoo. The data is subject to Yahoo's terms of use and is intended for personal use only; do not redistribute it. Helm stores it only on your machine.

## Other Python packages

numpy, pandas, scipy, matplotlib, scikit-learn, statsmodels, python-pptx and pypdfium2 are installed from PyPI under their own licenses (BSD, MIT, Apache-2.0 and similar). qlib and LightGBM (MIT), used by the optional research engine, are installed by you.

## deck-pipeline, mckinsey-charts, mckinsey-critic

The research-deck feature (`lib/deck/pipeline.mjs`, `engine/deck/helm_deck.py`) adapts the role split
(strategist → builder → critic → fixer), the review rubric and the chart conventions of these Claude skills.
No code was copied; prompts and chart styling were rewritten for Helm.

MIT License

Copyright (c) 2025 Sruthi Reddy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
