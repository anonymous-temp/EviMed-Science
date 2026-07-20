package com.sentum.drugsafe.utils;

import org.apache.commons.math3.special.Gamma;
import org.apache.commons.math3.util.CombinatoricsUtils;
import org.apache.commons.math3.util.FastMath;
import org.apache.commons.math3.distribution.NormalDistribution;

public class GPSCalculator {

    private double alpha1, beta1, alpha2, beta2, w;

    public GPSCalculator(double alpha1, double beta1, double alpha2, double beta2, double w) {
        this.alpha1 = alpha1;
        this.beta1 = beta1;
        this.alpha2 = alpha2;
        this.beta2 = beta2;
        this.w = w;
    }

    public double calculateGPS(double a, double b, double c, double d, Double alpha) {
        double E = ((a + b) * (a + c)) / (a + b + c + d);

        // 简化的似然比计算，实际应用中需根据具体统计模型调整
        double Q = w * negativeBinomialDensity(alpha1, a, beta1 + E) 
                  / binomialDensityApproximation(a, alpha1, beta1/(beta1+E), alpha2, beta2/(beta2+E));

        double EBlog = Q * (Gamma.digamma(alpha1 + a) - FastMath.log(beta1 + E))
                      + (1 - Q) * (Gamma.digamma(alpha2 + a) - FastMath.log(beta2 + E));
        
        double EBGM = FastMath.exp(EBlog);

        if (alpha == null) {
            return EBGM;
        } else {
            // 简化的置信区间计算示例，这里仅提供一个概念性框架
            // 实际置信区间计算可能需要更复杂的统计推断
            NormalDistribution normalDist = new NormalDistribution();
            double zScore = normalDist.inverseCumulativeProbability((1 + alpha) / 2); // 对应于(1-alpha)*100%的上侧尾部
            
            // 假设EBGM的方差可以用某种简单方式估算，这里仅为示例
            // 实际应用中需要根据模型和数据特性准确计算
            double varianceEstimate = calculateVarianceEstimate(a, b, c, d, E, alpha1, beta1, alpha2, beta2, w);
            double lowerBound = EBGM - zScore * FastMath.sqrt(varianceEstimate);
            
            return lowerBound;
        }
    }

    private double negativeBinomialDensity(double r, double x, double p) {
        return CombinatoricsUtils.factorialDouble((int) (x + r - 1)) /
               (CombinatoricsUtils.factorialDouble((int) x) * CombinatoricsUtils.factorialDouble((int) (r - 1)))
               * FastMath.pow(p, r) * FastMath.pow(1 - p, x);
    }

    private double binomialDensityApproximation(double x, double n1, double p1, double n2, double p2) {
        // 这里需要一个近似方法，因为dbinbinom在Java中没有直接对应函数
        // 实际应用中可能需要查找更精确的实现或方法
        throw new UnsupportedOperationException("Binomial density approximation not implemented");
    }

    // 示例方法，用于估算方差，实际应用中需要根据模型特性调整
    private double calculateVarianceEstimate(double a, double b, double c, double d, double E, double alpha1, double beta1, double alpha2, double beta2, double w) {
        // 这里仅提供一个占位符，实际方差计算会根据具体统计模型而异
        return 0.1; // 示例值，实际应根据模型计算
    }

    public static void main(String[] args) {
        // 示例使用，需要先通过fitPriorParametersGPS方法获取先验参数
        // GPSCalculator calculator = new GPSCalculator(alpha1Value, beta1Value, alpha2Value, beta2Value, wValue);
        // double result = calculator.calculateGPS(aValue, bValue, cValue, dValue, null); // 不计算置信区间
        // 或
        // double lowerBound = calculator.calculateGPS(aValue, bValue, cValue, dValue, 0.05); // 计算95%置信区间的下界
    }
}
