#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tdm_feasibility.py — 候选课题可行性量纲计算
输出: 可检出效应(N=6/5)、C/D 精度、采血时刻误差影响、频次映射敏感性、前瞻研究样本量
"""
import math
import json
from statistics import mean, stdev

out = {}

# ============ 1. 可检出相关系数 (80% power, alpha=0.05, 双侧) ============
# 用 Fisher z 变换: 样本量 n = 3 + (z_alpha2 + z_beta)^2 / arctanh(r)^2
def detect_r(n):
    if n - 3 <= 0:
        return None
    z = 1.96 + 0.84  # z_(1-alpha/2) + z_(1-beta)
    return math.tanh(z / math.sqrt(n - 3))

for n in [6, 10, 15, 20, 30, 50]:
    out[f"detectable_r_n{n}"] = round(detect_r(n), 3)

def n_for_r(r):
    z = 1.96 + 0.84
    return math.ceil(3 + (z / math.atanh(r)) ** 2)

out["n_for_r_0.55"] = n_for_r(0.55)   # 文献阿立哌唑剂量-浓度 r≈0.55 (Bachmann 2008)
out["n_for_r_0.70"] = n_for_r(0.70)

# ============ 2. C/D 比 (阿立哌唑) 描述精度 ============
cd_ari = [15.85, 20.0, 23.6, 7.99, 10.0]  # 来自 tdm_signal_result.json (ng/mL per mg/day)
m, sd = mean(cd_ari), stdev(cd_ari)
se = sd / math.sqrt(len(cd_ari))
ci = (m - 1.96 * se, m + 1.96 * se)
out["ari_cd_mean_sd"] = (round(m, 2), round(sd, 2))
out["ari_cd_ci"] = (round(ci[0], 2), round(ci[1], 2))
out["ari_cd_ci_halfwidth_pct"] = round(1.96 * se / m * 100, 1)
# 文献基准: 青少年研究 142 ng/mL @ 12.9 mg/d ≈ 11.0 (Bachmann 2008)
out["ari_cd_benchmark_bachmann"] = round(142.0 / 12.9, 1)

# ============ 3. 采血时刻误差对浓度的影响 (单房室稳态) ============
def time_error_factor(t_half, err_h):
    ke = math.log(2) / t_half
    return math.exp(ke * err_h)  # 浓度相对误差倍数

for drug, t_half in [("阿立哌唑", 75), ("奥氮平", 30), ("氯氮平", 16), ("帕利哌酮", 23)]:
    out[f"timeerr_{drug}"] = {
        "err2h": round(time_error_factor(t_half, 2), 3),
        "err6h": round(time_error_factor(t_half, 6), 3),
        "err12h": round(time_error_factor(t_half, 12), 3),
    }

# 峰谷比 (QD 给药): peak/trough = e^(ke*tau)
out["peak_trough_ari_QD"] = round(math.exp(math.log(2) / 75 * 24), 3)
out["peak_trough_clz_QD"] = round(math.exp(math.log(2) / 16 * 24), 3)

# ============ 4. 达标率 Wilson CI (n=6) ============
def wilson(k, n, z=1.96):
    p = k / n
    denom = 1 + z ** 2 / n
    center = (p + z ** 2 / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z ** 2 / (4 * n ** 2)) / denom
    return (max(0, center - half), min(1, center + half))

out["ari_range_achievement"] = {"in": 2, "n": 6, "pct": round(2 / 6 * 100, 1),
                                "wilson_ci": [round(x, 3) for x in wilson(2, 6)]}

# ============ 5. 频次映射敏感性 (氯氮平 C/D) ============
# 患者周岚: 氯氮平 100mg QD12 + 300mg QN
# 主映射: QD12=1次/日 -> 剂量400mg/日 -> C/D=721/400
# 备选映射: QD12=q12h(2次/日) -> 剂量500mg/日 -> C/D=721/500
out["clz_cd_main"] = round(721 / 400, 3)
out["clz_cd_alt_q12h"] = round(721 / 500, 3)
out["clz_cd_delta_pct"] = round((721 / 400 - 721 / 500) / (721 / 400) * 100, 1)
# 阿立哌唑订单频次(QN/QD/BID4)在两种映射下每日次数相同(BID4两种解读均为2次/日)
out["ari_freq_mapping_robust"] = "QN/QD/BID4 在主、备选映射下每日次数一致,阿立哌唑C/D不受频次解读影响"

# ============ 6. 前瞻研究样本量: 检出 C/D 组间差 (按 CYP2D6 表型代理中位分割) ============
# 用本数据 C/D 的 SD≈6.7, 均值≈15.5; 目标检出 30% 相对差 -> d=0.30*15.5/6.7≈0.69
for frac, label in [(0.30, "30pct"), (0.50, "50pct")]:
    d = frac * m / sd
    n_per = math.ceil(2 * (1.96 + 0.84) ** 2 / d ** 2)
    out[f"prospective_n_{label}_cd_diff"] = {"cohen_d": round(d, 2), "n_per_group": n_per,
                                             "n_total": 2 * n_per}

# ============ 7. 个体化预测: 新患者预测区间 ============
# 回归: 浓度~剂量, 若拟合 6 点, 预测区间宽度 (约 ±t*sqrt(MSE*(1+1/n+(x-xbar)^2/Sxx)))
# 简化: 用 C/D 变异表示, 预测新患者 C/D 的 95% 区间 = mean ± 2*SD 近似
out["new_patient_cd_interval"] = {
    "mean": round(m, 1), "sd": round(sd, 1),
    "p95_range": [round(m - 2 * sd, 1), round(m + 2 * sd, 1)],
    "fold_range": round((m + 2 * sd) / max(m - 2 * sd, 0.1), 2),
}

print(json.dumps(out, ensure_ascii=False, indent=1))
with open("/workspace/tdm_feasibility_result.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
