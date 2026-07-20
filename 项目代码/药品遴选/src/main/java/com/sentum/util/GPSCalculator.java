package com.sentum.util;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;

// 用于计算对数的工具类
class BigDecimalMath {
    private static final BigDecimal ONE = BigDecimal.ONE;
    private static final BigDecimal TWO = new BigDecimal("2");
    private static final MathContext MC = MathContext.DECIMAL128;

    private static final int MAX_RECURSION_DEPTH = 100; // 最大递归深度

    public static BigDecimal log(BigDecimal x) {
        return log(x, 0);
    }

    private static BigDecimal log(BigDecimal x, int depth) {
        if (depth > MAX_RECURSION_DEPTH) {
            System.err.println("递归深度超过限制");
            return null;
        }
        // 处理特殊情况：x 为 1 时，对数为 0
        if (x.compareTo(ONE) == 0) {
            return BigDecimal.ZERO;
        }
        // 处理 x 小于 1 的情况，利用对数性质 log(1/x) = -log(x)
        if (x.compareTo(ONE) < 0) {
            try {
                return log(ONE.divide(x, MC), depth + 1).negate();
            } catch (ArithmeticException e) {
                System.err.println("Error in division: " + e.getMessage());
                return null;
            }
        }

        // 选择合适的 a 使得 x / a 接近 1
        BigDecimal a = BigDecimal.TEN.pow((int) (Math.log10(x.doubleValue())));

        // 检查除数是否为零
        if (a.compareTo(BigDecimal.ZERO) == 0) {
            throw new IllegalArgumentException("除数不能为零");
        }

        // 直接处理 a 是 10 的整数次幂的情况
        if (a.remainder(BigDecimal.TEN).compareTo(BigDecimal.ZERO) == 0) {
            int power = (int) (Math.log10(a.doubleValue()));
            BigDecimal logA = new BigDecimal(power);
            if (x.compareTo(a) == 0) {
                return logA;
            }
        }

        BigDecimal adjustedX;
        try {
            adjustedX = x.divide(a, MC);
        } catch (ArithmeticException e) {
            System.err.println("除法运算出错: " + e.getMessage());
            return null;
        }

        // 利用公式 log(x) = 2 * atanh((x - 1) / (x + 1))
        BigDecimal y = adjustedX.subtract(ONE).divide(adjustedX.add(ONE), MC);
        BigDecimal term = y;
        BigDecimal result = term;
        int n = 1;

        // 终止条件：当某一项的值足够小（小于 1e-10）时停止累加
        while (term.abs().compareTo(new BigDecimal("1e-10")) > 0) {
            try {
                term = term.multiply(y.pow(2)).multiply(new BigDecimal(2 * n - 1)).divide(new BigDecimal(2 * n + 1), MC);
                result = result.add(term);
            } catch (ArithmeticException e) {
                System.err.println("计算出错: " + e.getMessage());
                return null;
            }
            n++;
        }

        // 加上 log(a)
        result = result.multiply(TWO).add(log(a, depth + 1));
        return result;
    }




    // 计算 BigDecimal 的指数


    public static BigDecimal exp(BigDecimal x) {
        if (x.compareTo(BigDecimal.ZERO) == 0) {
            return BigDecimal.ONE;
        }
        BigDecimal result = BigDecimal.ONE;
        BigDecimal term = BigDecimal.ONE;
        for (int n = 1; n < 100; n++) {
            term = term.multiply(x).divide(BigDecimal.valueOf(n), MC);
            result = result.add(term);
        }
        return result;
    }

    // 计算 BigDecimal 的平方根
    public static BigDecimal sqrt(BigDecimal x) {
        if (x.compareTo(BigDecimal.ZERO) < 0) {
            throw new IllegalArgumentException("平方根的参数不能为负数");
        }
        // 对于较大的数，使用更合适的初始猜测值
        BigDecimal guess;
        if (x.compareTo(new BigDecimal("1e6")) > 0) {
            guess = BigDecimal.valueOf(Math.sqrt(x.doubleValue()));
        } else {
            guess = x.divide(TWO, MC);
        }
        BigDecimal prevGuess;
        do {
            prevGuess = guess;
            try {
                guess = guess.add(x.divide(guess, MC)).divide(TWO, MC);
            } catch (ArithmeticException e) {
                System.err.println("Error in division: " + e.getMessage());
                return null;
            }
        } while (guess.subtract(prevGuess).abs().compareTo(new BigDecimal("1e-12")) > 0);
        return guess;
    }

    // 计算 BigDecimal 的伽马函数的对数
    public static BigDecimal gammaln(BigDecimal x) {
        return log(exp(x.subtract(BigDecimal.valueOf(0.5)).multiply(log(x))).divide(exp(x), MC).multiply(sqrt(BigDecimal.valueOf(2 * Math.PI))));
    }
}

// 用于优化的类
class Optimization {
    public static BigDecimal[] fitPriorParametersGPS(BigDecimal a, BigDecimal b, BigDecimal c, BigDecimal d) {
        BigDecimal alpha1 = new BigDecimal("0.2");
        BigDecimal beta1 = new BigDecimal("0.1");
        BigDecimal alpha2 = new BigDecimal("2.0");
        BigDecimal beta2 = new BigDecimal("4");
        BigDecimal w = BigDecimal.ONE.divide(BigDecimal.valueOf(3), MathContext.DECIMAL128);

        // 简单的梯度下降法进行优化，实际应用中可能需要更复杂的算法
        int maxIterations = 100;
        BigDecimal learningRate = new BigDecimal("0.01");
        for (int i = 0; i < maxIterations; i++) {
            BigDecimal[] gradients = computeGradients(alpha1, beta1, alpha2, beta2, w, a, b, c, d);
            alpha1 = alpha1.subtract(learningRate.multiply(gradients[0]));
            beta1 = beta1.subtract(learningRate.multiply(gradients[1]));
            alpha2 = alpha2.subtract(learningRate.multiply(gradients[2]));
            beta2 = beta2.subtract(learningRate.multiply(gradients[3]));
            w = w.subtract(learningRate.multiply(gradients[4]));
        }

        return new BigDecimal[]{alpha1, beta1, alpha2, beta2, w};
    }

    private static BigDecimal[] computeGradients(BigDecimal alpha1, BigDecimal beta1, BigDecimal alpha2, BigDecimal beta2, BigDecimal w, BigDecimal a, BigDecimal b, BigDecimal c, BigDecimal d) {
        // 这里需要根据对数似然函数的导数来计算梯度，具体实现省略
        return new BigDecimal[]{BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO};
    }
}

// 主类，包含 GPS 计算方法
public class GPSCalculator {
    public static BigDecimal GPS(BigDecimal a, BigDecimal b, BigDecimal c, BigDecimal d) {
        BigDecimal[] prior = Optimization.fitPriorParametersGPS(a, b, c, d);
        BigDecimal alpha1 = prior[0];
        BigDecimal beta1 = prior[1];
        BigDecimal alpha2 = prior[2];
        BigDecimal beta2 = prior[3];
        BigDecimal w = prior[4];

        BigDecimal E = a.add(b).multiply(a.add(c)).divide(a.add(b).add(c).add(d), MathContext.DECIMAL128);

        BigDecimal Q = w.multiply(dnbinom(a, alpha1, beta1.divide(beta1.add(E), MathContext.DECIMAL128)))
                .divide(dbinbinom(a, alpha1, beta1.divide(beta1.add(E), MathContext.DECIMAL128),
                        alpha2, beta2.divide(beta2.add(E), MathContext.DECIMAL128), w), MathContext.DECIMAL128);

        BigDecimal EBlog = Q.multiply(digamma(alpha1.add(a)).subtract(BigDecimalMath.log(beta1.add(E))))
                .add(BigDecimal.ONE.subtract(Q).multiply(digamma(alpha2.add(a)).subtract(BigDecimalMath.log(beta2.add(E)))));

        return BigDecimalMath.exp(EBlog);
    }

    // 计算负二项分布的概率质量函数
    private static BigDecimal dnbinom(BigDecimal x, BigDecimal size, BigDecimal prob) {
        BigDecimal numerator = BigDecimalMath.gammaln(x.add(size)).subtract(BigDecimalMath.gammaln(x.add(BigDecimal.ONE))).subtract(BigDecimalMath.gammaln(size))
                .add(size.multiply(BigDecimalMath.log(prob))).add(x.multiply(BigDecimalMath.log(BigDecimal.ONE.subtract(prob))));
        return BigDecimalMath.exp(numerator);
    }

    // 计算双峰负二项分布的概率质量函数
    private static BigDecimal dbinbinom(BigDecimal x, BigDecimal size1, BigDecimal prob1, BigDecimal size2, BigDecimal prob2, BigDecimal w) {
        return w.multiply(dnbinom(x, size1, prob1)).add(BigDecimal.ONE.subtract(w).multiply(dnbinom(x, size2, prob2)));
    }

    // 计算 digamma 函数，简单近似实现
    private static BigDecimal digamma(BigDecimal x) {
        // 简单的近似实现，实际应用中可能需要更精确的算法
        return BigDecimalMath.log(x);
    }

    public static void main(String[] args) {
        BigDecimal a = new BigDecimal("109");
        BigDecimal b = new BigDecimal("16133");
        BigDecimal c = new BigDecimal("5701");
        BigDecimal d = new BigDecimal("915710");

        BigDecimal result = GPS(a, b, c, d);
        System.out.println(result);
    }









}