"""Preprocessing pipeline for the Power Transformers FDD & RUL dataset.

The same code is used in training and deployment, so new data is always validated
and scaled exactly as the training data was.
"""
import hashlib
import json

import numpy as np
import pandas as pd

GAS_COLUMNS = ['H2', 'CO', 'C2H4', 'C2H2']
SEQ_LEN = 420
TIME_COLUMN_CANDIDATES = ['time', 'timestamp', 'step', 'time_step', 'Unnamed: 0']


class ValidationError(ValueError):
    pass


def check_frame(df, gas_columns=GAS_COLUMNS, seq_len=SEQ_LEN, negative_tolerance=0.0):
    """Validate one transformer's readings.

    Returns (array or None, issues dict). The array has shape (seq_len, n_gases), columns in
    `gas_columns` order and rows in their original (chronological) order. It is None when a
    structural problem (columns, length, time order) makes the file unusable.
    """
    issues = {}
    df = df.copy()
    df.columns = [str(c).strip() for c in df.columns]

    if len(set(df.columns)) != len(df.columns):
        issues['duplicate_columns'] = [c for c in df.columns if list(df.columns).count(c) > 1]
        return None, issues

    # Time order: the files have no time column, so row order is the time order and is never changed.
    # If a time/index column appears, it must be strictly increasing; it is then dropped.
    time_cols = [c for c in df.columns if c in TIME_COLUMN_CANDIDATES]
    for c in time_cols:
        t = pd.to_numeric(df[c], errors='coerce')
        if t.isna().any() or not t.is_monotonic_increasing or t.duplicated().any():
            issues['time_not_strictly_increasing'] = c
    df = df.drop(columns=time_cols)

    missing = [c for c in gas_columns if c not in df.columns]
    extra = [c for c in df.columns if c not in gas_columns]
    if missing:
        issues['missing_columns'] = missing
    if extra:
        issues['unexpected_columns'] = extra
    if len(df) != seq_len:
        issues['wrong_length'] = len(df)
    if issues:
        return None, issues

    df = df[gas_columns]  # enforce canonical column order
    numeric = df.apply(pd.to_numeric, errors='coerce')
    n_non_numeric = int((numeric.isna() & df.notna()).sum().sum())
    n_missing = int(df.isna().sum().sum())
    arr = numeric.to_numpy(dtype=np.float64)
    n_inf = int(np.isinf(arr).sum())
    n_negative = int((arr < -negative_tolerance).sum())

    if n_non_numeric:
        issues['non_numeric'] = n_non_numeric
    if n_missing:
        issues['missing_values'] = n_missing
    if n_inf:
        issues['infinite_values'] = n_inf
    if n_negative:
        issues['negative_values'] = n_negative
    return arr, issues


def series_hash(arr, near=False):
    """Hash of a series. near=True rounds to float32 first, so copies differing only by
    float noise hash the same."""
    a = np.ascontiguousarray(arr.astype(np.float32) if near else arr)
    return hashlib.md5(a.tobytes()).hexdigest()


class GasScaler:
    """Per-gas log1p(x / median) followed by standardisation. Fit on the training split only."""

    def fit(self, X):
        flat = X.reshape(-1, X.shape[-1])
        self.median_ = np.median(flat, axis=0)
        z = np.log1p(np.clip(flat, 0, None) / self.median_)
        self.mean_, self.std_ = z.mean(axis=0), z.std(axis=0)
        return self

    def transform(self, X):
        z = np.log1p(np.clip(X, 0, None) / self.median_)
        return ((z - self.mean_) / self.std_).astype(np.float32)

    def to_dict(self):
        return {'method': 'log1p(x / median) then standardise',
                'median': self.median_.tolist(), 'mean': self.mean_.tolist(), 'std': self.std_.tolist()}

    @classmethod
    def from_dict(cls, d):
        s = cls()
        s.median_, s.mean_, s.std_ = (np.array(d[k]) for k in ('median', 'mean', 'std'))
        return s


class TransformerPreprocessor:
    """Validation rules + fitted scaler. Save after training, load in deployment."""

    VERSION = 1

    def __init__(self, gas_columns=GAS_COLUMNS, seq_len=SEQ_LEN, negative_tolerance=0.0,
                 scaler=None, fdd_classes=None, metadata=None):
        self.gas_columns = list(gas_columns)
        self.seq_len = seq_len
        self.negative_tolerance = negative_tolerance
        self.scaler = scaler
        self.fdd_classes = fdd_classes
        self.metadata = metadata or {}

    def validate(self, df, name='input'):
        arr, issues = check_frame(df, self.gas_columns, self.seq_len, self.negative_tolerance)
        if issues:
            raise ValidationError(f'{name}: {issues}')
        return arr

    def fit(self, X_train):
        self.scaler = GasScaler().fit(X_train)
        return self

    def transform(self, X):
        """X: (n, seq_len, n_gases) raw array, or a single (seq_len, n_gases) series."""
        X = np.asarray(X, dtype=np.float64)
        single = X.ndim == 2
        if single:
            X = X[None]
        if X.shape[1:] != (self.seq_len, len(self.gas_columns)):
            raise ValidationError(f'expected (*, {self.seq_len}, {len(self.gas_columns)}), got {X.shape}')
        out = self.scaler.transform(X)
        return out[0] if single else out

    def process_csv(self, path):
        """Deployment entry point: one CSV -> GRU-ready array of shape (seq_len, n_gases)."""
        return self.transform(self.validate(pd.read_csv(path, dtype=str), name=str(path)))

    def encode_fdd(self, y):
        lookup = {c: i for i, c in enumerate(self.fdd_classes)}
        return np.array([lookup[v] for v in y], dtype=np.int64)

    def save(self, path):
        cfg = {
            'version': self.VERSION,
            'gas_columns': self.gas_columns,
            'seq_len': self.seq_len,
            'validation_rules': {
                'exact_column_set': self.gas_columns,
                'column_order_enforced': True,
                'sequence_length': self.seq_len,
                'row_order': 'kept as in file (chronological); optional time column must be strictly increasing',
                'reject_non_numeric': True,
                'reject_missing': True,
                'reject_infinite': True,
                'reject_negative_below': -self.negative_tolerance,
                'negatives_clipped_to_zero_before_scaling': True,
            },
            'scaler': self.scaler.to_dict(),
            'fdd_classes': self.fdd_classes,
            'metadata': self.metadata,
        }
        with open(path, 'w') as f:
            json.dump(cfg, f, indent=2)

    @classmethod
    def load(cls, path):
        with open(path) as f:
            cfg = json.load(f)
        return cls(gas_columns=cfg['gas_columns'], seq_len=cfg['seq_len'],
                   negative_tolerance=-cfg['validation_rules']['reject_negative_below'],
                   scaler=GasScaler.from_dict(cfg['scaler']),
                   fdd_classes=cfg['fdd_classes'], metadata=cfg.get('metadata'))
