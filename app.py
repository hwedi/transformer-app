"""Transformer Health Check: the web server.

What it does
  - serves the web page in static/
  - answers the page's questions under /api (see API_CONTRACT.md)
  - runs two models on a transformer's gas readings:
      FDD  (PyTorch) names the fault and says how sure it is
      RUL  (Keras)   estimates the remaining life in days, with a range

How it starts
  The server opens its port straight away, then loads the models in the background.
  Loading takes a minute or two. Until it finishes, /api/health says {"ready": false}
  and the page shows a "warming up" message. Azure needs the port to answer quickly,
  which is why it is done this way.

The model code is the same as in the earlier Gradio app, so answers do not change.
Start it with:  python app.py
"""
import os

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")   # quieter TensorFlow logs

import io
import json
import logging
import re
import sys
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("transformer-app")

HERE = Path(__file__).resolve().parent
ARTIFACTS = HERE / "artifacts"      # trained models and preprocessing (exported from Colab)
SAMPLES = HERE / "samples"          # example test transformers and their true answers
STATIC = HERE / "static"            # the web page
sys.path.insert(0, str(ARTIFACTS))  # so that "import tx_preprocessing" finds our own copy

STEP_DAYS = 0.5                     # one reading every 12 hours
MAX_UPLOAD_BYTES = 2 * 1024 * 1024  # 2 MB is far more than a real file needs
FAULT_NAMES = {1: "Normal", 2: "Partial discharge", 3: "Low-energy discharge", 4: "Low-temperature overheating"}
NOT_READY = "The models are still starting up. Try again in a minute."

# everything the models need lives in this dictionary once loading has finished
S = {"ready": False, "error": None}
LOCK = threading.Lock()             # the models answer one request at a time


# ---------------------------------------------------------------- loading
def natural_key(name):
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", name)]


def read_labels(filename, scale=1.0):
    """{sample id: value} from one of the label files, or {} if it is missing."""
    path = SAMPLES / filename
    if not path.exists():
        return {}
    df = pd.read_csv(path)
    id_col = "id" if "id" in df.columns else df.columns[0]
    value_col = [c for c in df.columns if c != id_col][0]
    return {str(i): float(v) * scale for i, v in zip(df[id_col], df[value_col])}


def load_everything():
    """Runs once, in the background, right after the server starts."""
    try:
        log.info("Loading libraries and models ...")
        import torch
        import torch.nn as nn
        from tensorflow import keras
        import tx_preprocessing as txp

        class GRUClassifier(nn.Module):          # same layout as in the FDD training section
            def __init__(self, n_features=4, hidden_size=64, num_layers=1, n_classes=4, dropout=0.3):
                super().__init__()
                self.gru = nn.GRU(input_size=n_features, hidden_size=hidden_size, num_layers=num_layers,
                                  batch_first=True, dropout=dropout if num_layers > 1 else 0.0)
                self.head = nn.Sequential(nn.Dropout(dropout), nn.Linear(hidden_size, hidden_size // 2), nn.ReLU(),
                                          nn.Dropout(dropout), nn.Linear(hidden_size // 2, n_classes))

            def forward(self, x):
                _, h_n = self.gru(x)
                return self.head(h_n[-1])

        pre = txp.TransformerPreprocessor.load(str(ARTIFACTS / "preprocessor.json"))

        bundle = torch.load(str(ARTIFACTS / "fdd_gru_model.pt"), map_location="cpu")
        fdd = GRUClassifier(**bundle["model_config"])
        fdd.load_state_dict(bundle["model_state"])
        fdd.eval()

        rul = keras.models.load_model(str(ARTIFACTS / "rul_cnn_gru_model.keras"))
        scaler = json.loads((ARTIFACTS / "rul_target_scaler.json").read_text())
        meta = json.loads((ARTIFACTS / "rul_deployment_metadata.json").read_text())

        sample_ids = sorted((p.name for p in SAMPLES.glob("*.csv") if not p.name.startswith("labels_")), key=natural_key) \
            if SAMPLES.exists() else []

        S.update(
            txp=txp, torch=torch, pre=pre, fdd=fdd, rul=rul, scaler=scaler,
            index_to_class={int(k): int(v) for k, v in bundle["index_to_fdd"].items()},
            threshold=float(bundle["confidence_handling"]["low_confidence_threshold"]),
            radius=float(meta["uncertainty_metadata"]["error_radius_days"]),
            cap_days=float(scaler["data_max_"][0]),
            sample_ids=sample_ids,
            true_class={k: int(v) for k, v in read_labels("labels_fdd_test.csv").items()},
            true_days=read_labels("labels_rul_test.csv", STEP_DAYS),
        )
        S["ready"] = True
        log.info("Ready: %d examples, threshold %.1f%%, range +/-%.0f days.", len(sample_ids), S["threshold"] * 100, S["radius"])
    except Exception as e:                       # keep the server up so /api/health can explain
        S["error"] = f"{type(e).__name__}: {e}"
        log.exception("The models could not be loaded")


@asynccontextmanager
async def lifespan(app):
    threading.Thread(target=load_everything, name="loader", daemon=True).start()
    yield


app = FastAPI(title="Transformer Health Check", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def headers(request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    path = request.url.path
    if path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    elif path.startswith(("/css/", "/js/", "/img/")):
        # always ask the server for a newer copy, so edited files show up on a normal refresh
        response.headers["Cache-Control"] = "no-cache"
    return response


# ---------------------------------------------------------------- the analysis
def friendly_problems(issues, seq_len, gases):
    """Turn the preprocessing module's problem list into sentences a person can act on."""
    g = ", ".join(gases[:-1]) + " and " + gases[-1]
    out = []
    if "duplicate_columns" in issues:
        out.append("The file repeats a column name (" + ", ".join(sorted(set(issues["duplicate_columns"]))) + "). Each gas should appear once.")
    if "time_not_strictly_increasing" in issues:
        out.append(f"The time column \"{issues['time_not_strictly_increasing']}\" is not in strict time order. Readings must run from oldest to newest.")
    if "missing_columns" in issues:
        m = issues["missing_columns"]
        out.append("The file is missing the column" + ("s " if len(m) > 1 else " ") + ", ".join(m) + f". It needs {g}.")
    if "unexpected_columns" in issues:
        out.append("The file has columns we do not use (" + ", ".join(issues["unexpected_columns"]) + f"). It should have only {g}.")
    if "wrong_length" in issues:
        out.append(f"The file has {issues['wrong_length']} readings, but exactly {seq_len} are needed (one every 12 hours).")
    if "non_numeric" in issues:
        out.append(f"{issues['non_numeric']} value(s) are not numbers.")
    if "missing_values" in issues:
        out.append(f"{issues['missing_values']} value(s) are empty.")
    if "infinite_values" in issues:
        out.append(f"{issues['infinite_values']} value(s) are infinite.")
    if "negative_values" in issues:
        out.append(f"{issues['negative_values']} value(s) are negative. Gas amounts cannot be negative.")
    return " ".join(out) or "The file could not be used."


def check_readings(df):
    """Validate a table of readings. Returns a (420, 4) array or raises HTTP 422 with a plain sentence."""
    pre = S["pre"]
    arr, issues = S["txp"].check_frame(df, pre.gas_columns, pre.seq_len, pre.negative_tolerance)
    if issues:
        raise HTTPException(422, friendly_problems(issues, pre.seq_len, pre.gas_columns))
    return arr


def analyse(raw, name):
    """Both models on one validated transformer. Same maths as the earlier Gradio app."""
    torch = S["torch"]
    x = S["pre"].transform(raw)[None]            # (1, 420, 4), scaled exactly like the training data
    with LOCK:
        with torch.no_grad():
            probs = torch.softmax(S["fdd"](torch.from_numpy(x).float()), dim=1)[0].numpy()
        scaled = float(S["rul"].predict(x, verbose=0).flatten()[0])
    idx = int(probs.argmax())
    cls = S["index_to_class"][idx]
    conf = float(probs[idx])
    by_class = {str(S["index_to_class"][i]): round(float(p), 6) for i, p in enumerate(probs)}

    days = max(0.0, (scaled - S["scaler"]["min_"][0]) / S["scaler"]["scale_"][0])
    radius, cap = S["radius"], S["cap_days"]
    series = {"days": [round(i * STEP_DAYS, 1) for i in range(raw.shape[0])]}
    for g, gas in enumerate(S["pre"].gas_columns):
        series[gas] = [round(float(v), 8) for v in raw[:, g]]

    return {
        "filename": name,
        "fdd": {"class": cls, "name": FAULT_NAMES.get(cls, str(cls)), "confidence": round(conf, 6),
                "probabilities": by_class, "needs_review": conf < S["threshold"], "threshold": S["threshold"]},
        "rul": {"days": round(days, 2), "months": round(days / 30.4, 2), "low": round(max(0.0, days - radius), 2),
                "high": round(days + radius, 2), "radius": radius, "near_cap": days >= 0.9 * cap, "cap_days": cap},
        "series": series,
        "actual": None,
    }


def require_ready():
    if not S["ready"]:
        raise HTTPException(503, NOT_READY)


def known_sample(sample_id):
    """Only names from our own list are accepted, so nobody can ask for other files on the server."""
    if sample_id not in S.get("sample_ids", []):
        raise HTTPException(404, "We could not find that example.")
    return SAMPLES / sample_id


# ---------------------------------------------------------------- the API
@app.get("/api/health")
def health():
    return {"ready": S["ready"], "error": S["error"]}


@app.get("/api/samples")
def samples():
    require_ready()
    return [{"id": i} for i in S["sample_ids"]]


@app.get("/api/samples/{sample_id}")
async def sample(sample_id: str):
    require_ready()
    path = known_sample(sample_id)

    def work():
        raw = check_readings(pd.read_csv(path, dtype=str))
        result = analyse(raw, sample_id)
        t, d = S["true_class"].get(sample_id), S["true_days"].get(sample_id)
        if t is not None or d is not None:
            result["actual"] = {"fdd_class": t, "rul_days": d}
        return result

    return await run_in_threadpool(work)


@app.get("/api/samples/{sample_id}/csv")
def sample_csv(sample_id: str):
    require_ready()
    return FileResponse(known_sample(sample_id), media_type="text/csv", filename=sample_id)


@app.post("/api/predict")
async def predict(file: UploadFile = File(...)):
    require_ready()
    data = await file.read(MAX_UPLOAD_BYTES + 1)           # never read more than the limit
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "That file is bigger than 2 MB. A transformer file should be much smaller than that.")
    name = os.path.basename(file.filename or "your file")[:80]

    def work():
        try:
            df = pd.read_csv(io.BytesIO(data), dtype=str)
        except Exception:
            raise HTTPException(422, "That file could not be read as a CSV. Export the readings as a .csv file and try again.")
        return analyse(check_readings(df), name)           # the upload is never saved

    return await run_in_threadpool(work)


@app.get("/api/model-info")
def model_info():
    require_ready()
    return {"fdd_threshold": S["threshold"], "rul_radius_days": S["radius"], "rul_cap_days": S["cap_days"],
            "readings_needed": S["pre"].seq_len, "gases": S["pre"].gas_columns}


@app.exception_handler(HTTPException)
async def plain_errors(request, exc):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)


# ---------------------------------------------------------------- the web page
@app.get("/", include_in_schema=False)
def home():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(STATIC / "img" / "favicon.svg", media_type="image/svg+xml")


for folder in ("css", "js", "fonts", "img"):
    if (STATIC / folder).is_dir():
        app.mount(f"/{folder}", StaticFiles(directory=str(STATIC / folder)), name=folder)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT") or os.environ.get("WEBSITES_PORT") or 8000)
    log.info("Starting on port %d", port)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
