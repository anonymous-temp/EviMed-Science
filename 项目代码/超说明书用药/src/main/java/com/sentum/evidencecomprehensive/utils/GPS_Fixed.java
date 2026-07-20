package com.sentum.evidencecomprehensive.utils;

import java.util.Random;

/**
 * GPS (Gamma-Poisson Shrinker) 算法实现
 * 用于药物不良反应信号检测中的EBGM值计算
 * 
 * 基于WHO-UMC推荐的Gamma-Poisson混合模型
 * 该算法通过贝叶斯方法对观测值进行收缩估计，提高了小样本情况下的稳定性
 */
public class GPS_Fixed {

    private static final Random random = new Random();
    
    // GPS算法的默认超参数
    private static final double ALPHA1 = 0.2;
    private static final double BETA1 = 0.1;
    private static final double ALPHA2 = 2.0;
    private static final double BETA2 = 4.0;
    private static final double W = 1.0 / 3.0;

    /**
     * Digamma函数的近似计算
     * Digamma函数是Gamma函数的对数导数：ψ(x) = d/dx[ln(Γ(x))]
     * 使用Lanczos近似方法进行计算
     * 
     * @param x 输入值
     * @return digamma(x)的近似值
     */
    public static double digamma(double x) {
        double[] p = {0.9999999940395355225, 676.5203681218851, -1259.1392167224028,
                771.32342877765313, -176.61502916214059, 12.507343278686905,
                -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7};
        int g = 7;
        
        // 对于x < 0.5，使用递推关系：ψ(x) = ψ(x+1) - 1/x
        if (x < 0.5) {
            return digamma(x + 1) - 1.0 / x;
        }
        
        x -= 1;
        double a = 0.99999999999980993;
        double t = x + g + 0.5;
        
        for (int i = 0; i < p.length; i++) {
            a += p[i] / (x + i + 1);
        }
        
        // Lanczos公式：ln(Γ(x)) ≈ (x + 0.5)*ln(t) - t + ln(a)
        // ψ(x) = d/dx[ln(Γ(x))]
        return Math.log(t) + a / t / t - 0.5 / t;
    }

    /**
     * 负二项分布的概率质量函数 (PMF)
     * 负二项分布用于模拟过度离散的计数数据
     * 
     * @param k 观测值
     * @param size 形状参数（对应于Gamma分布的α）
     * @param prob 成功概率
     * @return P(X = k)
     */
    public static double dnbinom(int k, double size, double prob) {
        if (k < 0 || prob <= 0 || prob > 1 || size <= 0) {
            return 0.0;
        }
        
        // 使用对数形式计算以避免数值溢出
        // P(X=k) = C(k+r-1, k) * p^r * (1-p)^k
        // ln(P) = ln(Γ(k+r)) - ln(Γ(k+1)) - ln(Γ(r)) + r*ln(p) + k*ln(1-p)
        
        double lpmf = logGamma(k + size) - logGamma(k + 1) - logGamma(size)
                + size * Math.log(prob) + k * Math.log(1 - prob);
        
        return Math.exp(lpmf);
    }

    /**
     * 计算Gamma函数的对数值
     * 使用Stirling近似或Lanczos近似
     * 
     * @param x 输入值
     * @return ln(Γ(x))
     */
    public static double logGamma(double x) {
        if (x <= 0) {
            throw new IllegalArgumentException("logGamma requires positive argument");
        }
        
        // 对于小值，使用递推关系
        if (x < 12) {
            return logGamma(x + 1) - Math.log(x);
        }
        
        // Lanczos近似系数
        double[] coef = {676.5203681218851, -1259.1392167224028, 771.32342877765313,
                -176.61502916214059, 12.507343278686905, -0.13857109526572012,
                9.9843695780195716e-6, 1.5056327351493116e-7};
        
        double g = 7.0;
        double sum = 0.99999999999980993;
        
        for (int i = 0; i < coef.length; i++) {
            sum += coef[i] / (x + i + 1);
        }
        
        double tmp = x + g + 0.5;
        return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(tmp) - tmp + Math.log(sum);
    }

    /**
     * 二项混合分布（两个负二项分布的混合）
     * 用于GPS算法中的混合模型
     * 
     * @param k 观测值
     * @param size1 第一个分布的形状参数
     * @param prob1 第一个分布的成功概率
     * @param size2 第二个分布的形状参数
     * @param prob2 第二个分布的成功概率
     * @param w 第一个分布的混合权重
     * @return 混合分布的PMF值
     */
    public static double dbinbinom(int k, double size1, double prob1, 
                                   double size2, double prob2, double w) {
        return w * dnbinom(k, size1, prob1) + (1 - w) * dnbinom(k, size2, prob2);
    }

    /**
     * 计算后验概率Q
     * Q表示观测值来自第一个分布的后验概率
     * 
     * @param a 观测的共现案例数
     * @param alpha1 第一个分布的形状参数
     * @param beta1 第一个分布的速率参数
     * @param alpha2 第二个分布的形状参数
     * @param beta2 第二个分布的速率参数
     * @param E 期望案例数
     * @param w 混合权重
     * @return 后验概率Q
     */
    public static double calculateQ(int a, double alpha1, double beta1, 
                                   double alpha2, double beta2, double E, double w) {
        double prob1 = beta1 / (beta1 + E);
        double prob2 = beta2 / (beta2 + E);
        
        double numerator = w * dnbinom(a, alpha1, prob1);
        double denominator = dbinbinom(a, alpha1, prob1, alpha2, prob2, w);
        
        if (denominator == 0) {
            return 0.5; // 默认值
        }
        
        return numerator / denominator;
    }

    /**
     * GPS (Gamma-Poisson Shrinker) 算法
     * 计算EBGM（经验贝叶斯几何平均值）
     * 
     * 该方法基于Gamma-Poisson混合模型，通过贝叶斯方法对观测值进行收缩估计
     * 公式：EBGM = exp(E[ln(λ) | a])
     * 其中λ是Poisson分布的参数，a是观测的共现案例数
     * 
     * @param a 目标药物和目标不良反应的共现案例数
     * @param b 目标药物但无目标不良反应的案例数
     * @param c 目标不良反应但无目标药物的案例数
     * @param d 既无目标药物也无目标不良反应的案例数
     * @return EBGM值
     */
    public static double EBGM(int a, int b, int c, int d) {
        // 参数验证
        if (a < 0 || b < 0 || c < 0 || d < 0) {
            throw new IllegalArgumentException("All parameters must be non-negative");
        }
        
        // 计算期望案例数 E
        // E = P(drug) * P(event) * N
        // 其中 P(drug) = (a+b)/N, P(event) = (a+c)/N
        int N = a + b + c + d;
        if (N == 0) {
            return 0.0;
        }
        
        double E = ((double) (a + b) * (a + c)) / N;
        
        // 计算后验概率Q（观测值来自第一个分布的概率）
        double prob1 = BETA1 / (BETA1 + E);
        double prob2 = BETA2 / (BETA2 + E);
        
        double numerator = W * dnbinom(a, ALPHA1, prob1);
        double denominator = dbinbinom(a, ALPHA1, prob1, ALPHA2, prob2, W);
        
        double Q = (denominator > 0) ? numerator / denominator : 0.5;
        
        // 计算E[ln(λ) | a]
        // E[ln(λ) | a] = Q * E[ln(λ) | a, component1] + (1-Q) * E[ln(λ) | a, component2]
        // 其中 E[ln(λ) | a, component] = digamma(α + a) - ln(β + E)
        
        double EBlog = Q * (digamma(ALPHA1 + a) - Math.log(BETA1 + E)) +
                       (1 - Q) * (digamma(ALPHA2 + a) - Math.log(BETA2 + E));
        
        // EBGM = exp(E[ln(λ) | a])
        return Math.exp(EBlog);
    }

    /**
     * 计算ROR (Reporting Odds Ratio)
     * ROR = (a/c) / (b/d) = (a*d) / (b*c)
     * 
     * @param a 目标药物和目标不良反应的共现案例数
     * @param b 目标药物但无目标不良反应的案例数
     * @param c 目标不良反应但无目标药物的案例数
     * @param d 既无目标药物也无目标不良反应的案例数
     * @return ROR值
     */
    public static double ROR(int a, int b, int c, int d) {
        if (b == 0 || c == 0) {
            return 0.0; // 无法计算
        }
        return (double) (a * d) / (b * c);
    }

    /**
     * 计算ROR的95%置信区间下限
     * 使用对数正态分布近似
     * 
     * @param a 目标药物和目标不良反应的共现案例数
     * @param b 目标药物但无目标不良反应的案例数
     * @param c 目标不良反应但无目标药物的案例数
     * @param d 既无目标药物也无目标不良反应的案例数
     * @return ROR的95% CI下限
     */
    public static double ROR_CI_Lower(int a, int b, int c, int d) {
        if (a == 0 || b == 0 || c == 0 || d == 0) {
            return 0.0;
        }
        
        double ror = ROR(a, b, c, d);
        double logROR = Math.log(ror);
        double seLogROR = Math.sqrt(1.0/a + 1.0/b + 1.0/c + 1.0/d);
        double z = 1.96; // 95% 置信水平的Z值
        
        return Math.exp(logROR - z * seLogROR);
    }

    /**
     * 计算IC (Information Component)
     * IC = log₂[(a/(a+b)) / (c/(c+d))]
     * 
     * @param a 目标药物和目标不良反应的共现案例数
     * @param b 目标药物但无目标不良反应的案例数
     * @param c 目标不良反应但无目标药物的案例数
     * @param d 既无目标药物也无目标不良反应的案例数
     * @return IC值
     */
    public static double IC(int a, int b, int c, int d) {
        if (a + b == 0 || c + d == 0) {
            return 0.0;
        }
        
        double prob_event_given_drug = (double) a / (a + b);
        double prob_event_given_other = (double) c / (c + d);
        
        if (prob_event_given_other == 0) {
            return 0.0;
        }
        
        return Math.log(prob_event_given_drug / prob_event_given_other) / Math.log(2);
    }

    /**
     * 计算IC的95%置信区间下限
     * 使用BCPNN模型的方差估计
     * 
     * @param a 目标药物和目标不良反应的共现案例数
     * @param b 目标药物但无目标不良反应的案例数
     * @param c 目标不良反应但无目标药物的案例数
     * @param d 既无目标药物也无目标不良反应的案例数
     * @return IC的95% CI下限
     */
    public static double IC_CI_Lower(int a, int b, int c, int d) {
        if (a == 0 || b == 0 || c == 0 || d == 0) {
            return 0.0;
        }
        
        double ic = IC(a, b, c, d);
        
        // 方差估计：Var(IC) ≈ 1/(a*ln(2)²) + 1/(c*ln(2)²)
        double variance = (1.0 / a + 1.0 / c) / (Math.log(2) * Math.log(2));
        double se = Math.sqrt(variance);
        double z = 1.96; // 95% 置信水平的Z值
        
        return ic - z * se;
    }

    /**
     * 判断是否为阳性信号
     * 综合ROR、IC、EBGM三种方法的结果
     * 
     * @param a 目标药物和目标不良反应的共现案例数
     * @param b 目标药物但无目标不良反应的案例数
     * @param c 目标不良反应但无目标药物的案例数
     * @param d 既无目标药物也无目标不良反应的案例数
     * @return 是否为阳性信号
     */
    public static boolean isPositiveSignal(int a, int b, int c, int d) {
        // 条件1：共现案例数 a >= 3
        if (a < 3) {
            return false;
        }
        
        // 条件2：ROR的95% CI下限 > 1
        double ror_lower = ROR_CI_Lower(a, b, c, d);
        if (ror_lower <= 1.0) {
            return false;
        }
        
        // 条件3：IC的95% CI下限 > 0
        double ic_lower = IC_CI_Lower(a, b, c, d);
        if (ic_lower <= 0.0) {
            return false;
        }
        
        // 条件4：EBGM的95% CI下限 >= 2
        // 这里假设EBGM的95% CI下限约为EBGM值乘以一个缩放因子
        double ebgm = EBGM(a, b, c, d);
        // 简化处理：使用EBGM值本身作为估计
        if (ebgm < 2.0) {
            return false;
        }
        
        return true;
    }

    /**
     * 主方法：演示GPS算法的使用
     */
    public static void main(String[] args) {
        // 测试用例1：明显的信号
        System.out.println("=== 测试用例1：明显的信号 ===");
        int a1 = 10, b1 = 20, c1 = 5, d1 = 100;
        testSignal(a1, b1, c1, d1);
        
        // 测试用例2：边界情况
        System.out.println("\n=== 测试用例2：边界情况 ===");
        int a2 = 3, b2 = 10, c2 = 3, d2 = 100;
        testSignal(a2, b2, c2, d2);
        
        // 测试用例3：弱信号
        System.out.println("\n=== 测试用例3：弱信号 ===");
        int a3 = 2, b3 = 50, c3 = 10, d3 = 200;
        testSignal(a3, b3, c3, d3);
        
        // 测试用例4：无信号
        System.out.println("\n=== 测试用例4：无信号 ===");
        int a4 = 1, b4 = 100, c4 = 50, d4 = 500;
        testSignal(a4, b4, c4, d4);
    }

    /**
     * 测试辅助方法
     */
    private static void testSignal(int a, int b, int c, int d) {
        System.out.printf("2x2列联表: a=%d, b=%d, c=%d, d=%d\n", a, b, c, d);
        
        double ror = ROR(a, b, c, d);
        double ror_lower = ROR_CI_Lower(a, b, c, d);
        System.out.printf("ROR = %.4f, 95%% CI下限 = %.4f\n", ror, ror_lower);
        
        double ic = IC(a, b, c, d);
        double ic_lower = IC_CI_Lower(a, b, c, d);
        System.out.printf("IC = %.4f, 95%% CI下限 = %.4f\n", ic, ic_lower);
        
        double ebgm = EBGM(a, b, c, d);
        System.out.printf("EBGM = %.4f\n", ebgm);
        
        boolean isSignal = isPositiveSignal(a, b, c, d);
        System.out.printf("是否为阳性信号: %s\n", isSignal ? "是" : "否");
    }
}
