package com.sentum.util;

import org.apache.commons.math3.special.Gamma;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.List;

public class RORAndCIUtil {

    // 计算相对危险度（ROR）
    public static BigDecimal calculateROR(BigDecimal a, BigDecimal b, BigDecimal c, BigDecimal d) {
        // 计算分子 ad
        BigDecimal numerator = a.multiply(d);

        // 计算分母 bc
        BigDecimal denominator = b.multiply(c);

        // 分母检查是否为 0
        if (BigDecimal.ZERO.equals(denominator)) {
            // 方式一：返回默认值（例如 0）
            // return BigDecimal.ZERO;

            // 方式二：抛出自定义异常
            throw new IllegalArgumentException("Denominator is zero in ROR calculation. b = " + b + ", c = " + c);
        }

        return numerator.divide(denominator, MathContext.DECIMAL128);
    }

    // 计算 ROR 的 95% 置信区间
    public static BigDecimal[] calculate95CI(BigDecimal a, BigDecimal b, BigDecimal c, BigDecimal d) {
        // 计算 ROR
        BigDecimal ror = calculateROR(a, b, c, d);

        // 计算 ln(ROR)
        BigDecimal lnROR = BigDecimal.valueOf(Math.log(ror.doubleValue()));

        // 计算标准误差 se = sqrt(1/a + 1/b + 1/c + 1/d)
        BigDecimal se = BigDecimal.valueOf(
                Math.sqrt(
                        BigDecimal.ONE.divide(a, MathContext.DECIMAL128).doubleValue() +
                                BigDecimal.ONE.divide(b, MathContext.DECIMAL128).doubleValue() +
                                BigDecimal.ONE.divide(c, MathContext.DECIMAL128).doubleValue() +
                                BigDecimal.ONE.divide(d, MathContext.DECIMAL128).doubleValue()
                )
        );

        // 计算 1.96 * se
        BigDecimal multiplier = BigDecimal.valueOf(1.96).multiply(se);

        // 计算下限和上限
        BigDecimal lower = BigDecimal.valueOf(Math.exp(lnROR.subtract(multiplier).doubleValue()));
        BigDecimal upper = BigDecimal.valueOf(Math.exp(lnROR.add(multiplier).doubleValue()));

        return new BigDecimal[]{lower, upper};
    }

//    public static BigDecimal calculateIC(BigDecimal a, BigDecimal b, BigDecimal c, BigDecimal d) {
//        // 计算分子 a + b + c + d
//        BigDecimal numerator = a.add(b).add(c).add(d);
//
//        // 计算分母 (a + c)(a + b)
//        BigDecimal denominator = a.add(c).multiply(a.add(b));
//
//        // 计算分数值
//        BigDecimal fraction = numerator.divide(denominator, MathContext.DECIMAL128);
//
//        // 计算对数的底数 2a
//        BigDecimal base = a.multiply(BigDecimal.valueOf(2));
//
//        // 使用换底公式计算对数 log_{2a}(fraction) = ln(fraction) / ln(2a)
//        double lnFraction = Math.log(fraction.doubleValue());
//        double lnBase = Math.log(base.doubleValue());
//        BigDecimal ic = BigDecimal.valueOf(lnFraction / lnBase);
//
//        return ic;
//    }

    public static double digamma(double x) {
        // Approximation of the digamma function using the Lanczos approximation
        // This is a simplified version for demonstration purposes
        double[] p = {0.9999999940395355225, 676.5203681218851, -1259.1392167224028,
                771.32342877765313, -176.61502916214059, 12.507343278686905,
                -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7};
        int g = 7;
        if (x < 0.5) return digamma(x + 1) - 1.0 / x;
        x -= 1;
        double a = 0.99999999999980993;
        double t = x + g + 0.5;
        for (int i = 0; i < p.length; i++) {
            a += p[i] / (x + i + 1);
        }
        return Math.log(t) - 0.5 / t + a / t / t;
    }

    public static double dnbinom(int k, double size, double prob) {
        // Probability mass function of the negative binomial distribution
        double lgam = Math.log(size) - digamma(size);
        double lpmf = k * Math.log(prob) + size * Math.log(1 - prob) + lgam - digamma(k + size);
        return Math.exp(lpmf);
    }

    public static double dbinbinom(int k, double size1, double prob1, double size2, double prob2, double w) {
        // Binomial mixture distribution
        return w * dnbinom(k, size1, prob1) + (1 - w) * dnbinom(k, size2, prob2);
    }

    public static double GPS(int a, int b, int c, int d) {
        double alpha1 = 0.2;
        double beta1 = 0.1;
        double alpha2 = 2.0;
        double beta2 = 4;
        double w = 1.0 / 3;
        a = (int) Math.min(Integer.MAX_VALUE, a); // Prevent integer overflow
        b = (int) Math.min(Integer.MAX_VALUE, b);
        c = (int) Math.min(Integer.MAX_VALUE, c);
        d = (int) Math.min(Integer.MAX_VALUE, d);
        double E = ((double) (a + b) * (a + c)) / (a + b + c + d);
        double Q = w * dnbinom(a, alpha1, beta1 / (beta1 + E)) /
                dbinbinom(a, alpha1, beta1 / (beta1 + E), alpha2, beta2 / (beta2 + E), w);

        double EBlog = (Q * (digamma(alpha1 + a) - Math.log(beta1 + E)) +
                (1 - Q) * (digamma(alpha2 + a) - Math.log(beta2 + E)));

        return Math.exp(EBlog);
    }


    private static final BigDecimal LOG_2 = BigDecimal.valueOf(Math.log(2));
    private static final BigDecimal ONE = BigDecimal.ONE;

    public static BigDecimal[] calculateBCPNN(BigDecimal[] a, BigDecimal[] b, BigDecimal[] c, BigDecimal[] d) {
        BigDecimal[] icValues = new BigDecimal[a.length];
        for (int i = 0; i < a.length; i++) {
            icValues[i] = calculateIC(a[i], b[i], c[i], d[i]);
        }
        return icValues;
    }

    public static BigDecimal calculateIC(BigDecimal a, BigDecimal b, BigDecimal c, BigDecimal d) {
        BigDecimal n1_ = a.add(c);
        BigDecimal n_1 = a.add(b);
        BigDecimal n = a.add(b).add(c).add(d);
        BigDecimal p1 = ONE.add(n1_);
        BigDecimal p2 = ONE.add(n).subtract(n1_);
        BigDecimal q1 = ONE.add(n_1);
        BigDecimal q2 = ONE.add(n).subtract(n_1);
        BigDecimal r1 = a.add(ONE);
        BigDecimal r2b = n.subtract(a).subtract(ONE)
                .add(BigDecimal.valueOf(2).add(n).pow(2)
                        .divide(q1.multiply(p1), MathContext.DECIMAL128));

        BigDecimal digammaR1 = BigDecimal.valueOf(Gamma.digamma(r1.doubleValue()));
        BigDecimal digammaR1R2b = BigDecimal.valueOf(Gamma.digamma(r1.add(r2b).doubleValue()));
        BigDecimal digammaP1 = BigDecimal.valueOf(Gamma.digamma(p1.doubleValue()));
        BigDecimal digammaP1P2 = BigDecimal.valueOf(Gamma.digamma(p1.add(p2).doubleValue()));
        BigDecimal digammaQ1 = BigDecimal.valueOf(Gamma.digamma(q1.doubleValue()));
        BigDecimal digammaQ1Q2 = BigDecimal.valueOf(Gamma.digamma(q1.add(q2).doubleValue()));

        BigDecimal numerator = digammaR1.subtract(digammaR1R2b)
                .subtract(digammaP1.subtract(digammaP1P2).add(digammaQ1).subtract(digammaQ1Q2));

        BigDecimal ic = numerator.divide(LOG_2, MathContext.DECIMAL128);

        return ic;
    }


    public static void main(String[] args) {
        ArrayList<List<Integer>> lists = new ArrayList<>();
        ArrayList<Integer> integer1 = new ArrayList<>();
        integer1.add(97);
        integer1.add(7362);
        integer1.add(74261);
        integer1.add(19028295);

        ArrayList<Integer> integer2 = new ArrayList<>();
        integer2.add(26);
        integer2.add(3482);
        integer2.add(74261);
        integer2.add(19028295);

        ArrayList<Integer> integer3 = new ArrayList<>();
        integer3.add(17);
        integer3.add(2157);
        integer3.add(74261);
        integer3.add(19028295);

        ArrayList<Integer> integer4 = new ArrayList<>();
        integer4.add(11);
        integer4.add(1105);
        integer4.add(74261);
        integer4.add(19028295);

        ArrayList<Integer> integer5 = new ArrayList<>();
        integer5.add(1);
        integer5.add(872);
        integer5.add(74261);
        integer5.add(19028295);

        ArrayList<Integer> integer6 = new ArrayList<>();
        integer6.add(16);
        integer6.add(2484);
        integer6.add(74261);
        integer6.add(19028295);

        ArrayList<Integer> integer7 = new ArrayList<>();
        integer7.add(9);
        integer7.add(4125);
        integer7.add(74261);
        integer7.add(19028295);

        ArrayList<Integer> integer8 = new ArrayList<>();
        integer8.add(2);
        integer8.add(556);
        integer8.add(74261);
        integer8.add(19028295);

        ArrayList<Integer> integer9 = new ArrayList<>();
        integer9.add(8);
        integer9.add(8037);
        integer9.add(74261);
        integer9.add(19028295);

        ArrayList<Integer> integer10 = new ArrayList<>();
        integer10.add(25);
        integer10.add(5046);
        integer10.add(74261);
        integer10.add(19028295);

        lists.add(integer1);
        lists.add(integer2);
        lists.add(integer3);
        lists.add(integer4);
        lists.add(integer5);
        lists.add(integer6);
        lists.add(integer7);
        lists.add(integer8);
        lists.add(integer9);
        lists.add(integer10);

        for (int i = 0; i < lists.size(); i++) {

        int a1 = lists.get(i).get(0);
            int b1 = lists.get(i).get(1) -lists.get(i).get(0);
            int c1 = lists.get(i).get(2)- lists.get(i).get(0);
            int d1 = lists.get(i).get(3)- a1- b1- c1;

        // 示例数据
        BigDecimal a = new BigDecimal(a1);
        BigDecimal b = new BigDecimal(b1);
        BigDecimal c = new BigDecimal(c1);
        BigDecimal d = new BigDecimal(d1);

        // 计算 ROR
        BigDecimal ror = calculateROR(a, b, c, d);
//        System.out.println("ROR: " + ror.setScale(4, RoundingMode.HALF_UP));

        // 计算 95% 置信区间
        BigDecimal[] ci = calculate95CI(a, b, c, d);
//        System.out.println("95% CI: (" + ci[0].setScale(4, RoundingMode.HALF_UP) + ", " + ci[1].setScale(4, RoundingMode.HALF_UP) + ")");




        BigDecimal ic = calculateIC(a, b, c, d);
//        System.out.println("IC: " + ic.setScale(4, RoundingMode.HALF_UP));

            BigDecimal[] interval = calculateIC95Interval(a1, b1, c1, d1,ic );
        BigDecimal gps = GPSCalculator.GPS(a, b, c, d);
//        System.out.println("GPS: " + gps.setScale(4, RoundingMode.HALF_UP));
        //ic
        //gps保留四位小数
        gps = gps.setScale(4, RoundingMode.HALF_UP);

        //占比计算  list中第一个占第二个的比值lists.get(i).get(0), lists.get(i).get(1)的比值  百分比，后者除以前者
            BigDecimal ratio = a.divide(BigDecimal.valueOf(lists.get(i).get(1)), 6, RoundingMode.HALF_UP);

            //转化为百分比   使用  **.**% 表示百分比
            ratio = ratio.multiply(new BigDecimal("100")).setScale(2, RoundingMode.HALF_UP);


            System.out.println("a:"+a+"    占比:"+ratio+"%");
        System.out.println(ror.setScale(4, RoundingMode.HALF_UP)+"("+ci[0].setScale(4, RoundingMode.HALF_UP) + ", " + ci[1].setScale(4, RoundingMode.HALF_UP)+")     "
                +ic.setScale(4, RoundingMode.HALF_UP)+"("+interval[0]+","+interval[1]+")     "+gps);
        }


    }




    /**
     * FEARS数据库IC值95%置信区间计算工具（Java 8适配）
     * 入参：四格表计数（N11/N10/N01/N00）、预计算的IC值
     * 出参：IC值95%置信区间上限（IC_U）、下限（ICL0.05）
     */


        // 常量定义（避免硬编码，保证精度）
        // ln2（自然对数，精确到15位小数）
        private static final BigDecimal LN2 = new BigDecimal("0.6931471805599453");
        // ln2的平方（ln2²，精确到15位小数）
        private static final BigDecimal LN2_SQUARE = LN2.multiply(LN2, MathContext.DECIMAL128);
        // 95%置信水平对应的Z临界值（1.96，精确到15位小数）
        private static final BigDecimal Z_95 = new BigDecimal("1.96");
        // 平滑处理常量（N11=0时加1，避免分母为0）
        private static final BigDecimal SMOOTH_CONST = BigDecimal.ONE;
        // 计算精度上下文（15位有效数字，四舍五入）
        private static final MathContext MATH_CONTEXT = new MathContext(15, RoundingMode.HALF_UP);


        /**
         * 计算IC值的95%置信区间（上限+下限）
         * @param N11 目标药物+目标不良反应的报告例数（不可为负）
         * @param N10 目标药物+其他不良反应的报告例数（不可为负）
         * @param N01 其他药物+目标不良反应的报告例数（不可为负）
         * @param N00 其他药物+其他不良反应的报告例数（不可为负）
         * @param ic 预计算的IC值（BigDecimal类型，避免二次计算误差）
         * @return 置信区间结果数组：[0] = 上限IC_U，[1] = 下限ICL0.05
         * @throws IllegalArgumentException 入参为负时抛出异常
         */
        public static BigDecimal[] calculateIC95Interval(
                long N11, long N10, long N01, long N00, BigDecimal ic) {

            // 1. 入参合法性校验（避免负计数）
            validateNonNegative(N11, "N11");
            validateNonNegative(N10, "N10");
            validateNonNegative(N01, "N01");
            validateNonNegative(N00, "N00");
            if (ic == null) {
                throw new IllegalArgumentException("IC值不可为null");
            }


            // 2. 将long计数转换为BigDecimal（避免溢出）
            BigDecimal bdN11 = BigDecimal.valueOf(N11);
            BigDecimal bdN10 = BigDecimal.valueOf(N10);
            BigDecimal bdN01 = BigDecimal.valueOf(N01);
            BigDecimal bdN00 = BigDecimal.valueOf(N00);


            // 3. 计算四格表合计值（核心：避免乘法/加法溢出）
            // N1. = N11 + N10（目标药物总报告数）
            BigDecimal bdN1Dot = bdN11.add(bdN10, MATH_CONTEXT);
            // N0. = N01 + N00（其他药物总报告数）
            BigDecimal bdN0Dot = bdN01.add(bdN00, MATH_CONTEXT);
            // N.1 = N11 + N01（目标不良反应总报告数）
            BigDecimal bdNDot1 = bdN11.add(bdN01, MATH_CONTEXT);
            // N总 = N1. + N0.（数据库总样本量）
            BigDecimal bdNTotal = bdN1Dot.add(bdN0Dot, MATH_CONTEXT);


            // 4. N11平滑处理（若N11=0，加1避免分母为0）
            BigDecimal bdN11Smoothed = bdN11.compareTo(BigDecimal.ZERO) == 0
                    ? bdN11.add(SMOOTH_CONST, MATH_CONTEXT)
                    : bdN11;


            // 5. 计算IC值的方差Var(IC) = 1/(ln2²) × (1/N11 + 1/N1. + 1/N.1 - 1/N总)
            // 5.1 计算各项倒数（1/N11、1/N1.、1/N.1、1/N总）
            BigDecimal invN11 = BigDecimal.ONE.divide(bdN11Smoothed, MATH_CONTEXT);
            BigDecimal invN1Dot = BigDecimal.ONE.divide(bdN1Dot, MATH_CONTEXT);
            BigDecimal invNDot1 = BigDecimal.ONE.divide(bdNDot1, MATH_CONTEXT);
            BigDecimal invNTotal = BigDecimal.ONE.divide(bdNTotal, MATH_CONTEXT);

            // 5.2 计算括号内的和（1/N11 + 1/N1. + 1/N.1 - 1/N总）
            BigDecimal sumTerm = invN11.add(invN1Dot, MATH_CONTEXT)
                    .add(invNDot1, MATH_CONTEXT)
                    .subtract(invNTotal, MATH_CONTEXT);

            // 5.3 计算方差（1/ln2² × 括号内和）
            BigDecimal varIC = BigDecimal.ONE.divide(LN2_SQUARE, MATH_CONTEXT)
                    .multiply(sumTerm, MATH_CONTEXT);


            // 6. 计算IC值的标准误SE(IC) = √Var(IC)（BigDecimal开方需借助MathContext）
            BigDecimal seIC = sqrt(varIC, MATH_CONTEXT);


            // 7. 计算95%置信区间上下限
            // 边际误差 = 1.96 × SE(IC)
            BigDecimal marginError = Z_95.multiply(seIC, MATH_CONTEXT);
            // 上限IC_U = IC + 边际误差
            BigDecimal icUpper = ic.add(marginError, MATH_CONTEXT);

            //保留四位小数，四舍五入
            icUpper = icUpper.setScale(4, RoundingMode.HALF_UP);

            // 下限ICL0.05 = IC - 边际误差
            BigDecimal icLower = ic.subtract(marginError, MATH_CONTEXT);

            //保留四位小数，四舍五入
            icLower = icLower.setScale(4, RoundingMode.HALF_UP);


            // 8. 返回结果：[0]上限，[1]下限
            return new BigDecimal[]{icUpper, icLower};
        }


        /**
         * 辅助方法：校验数值是否非负
         * @param value 待校验的long值
         * @param paramName 参数名称（用于异常提示）
         * @throws IllegalArgumentException 若value<0则抛出异常
         */
        private static void validateNonNegative(long value, String paramName) {
            if (value < 0) {
                throw new IllegalArgumentException(String.format("参数%s不可为负数：%d", paramName, value));
            }
        }


        /**
         * 辅助方法：BigDecimal开平方（Java 8无原生sqrt方法，基于牛顿迭代法实现）
         * @param value 待开方的BigDecimal（必须非负）
         * @param mathContext 计算精度上下文
         * @return 开方结果（√value）
         * @throws IllegalArgumentException 若value为负则抛出异常
         */
        private static BigDecimal sqrt(BigDecimal value, MathContext mathContext) {
            // 校验非负
            if (value.compareTo(BigDecimal.ZERO) < 0) {
                throw new IllegalArgumentException("开平方的数值不可为负数：" + value);
            }
            // 特殊值处理（0和1的平方根为自身）
            if (value.compareTo(BigDecimal.ZERO) == 0 || value.compareTo(BigDecimal.ONE) == 0) {
                return value;
            }

            // 牛顿迭代法实现开方（精度由mathContext控制）
            BigDecimal x0 = BigDecimal.ZERO;
            BigDecimal x1 = new BigDecimal(Math.sqrt(value.doubleValue())); // 初始值（用double快速逼近）
            // 迭代终止条件：两次结果差的绝对值小于精度阈值（1e-15）
            while (x1.subtract(x0).abs().compareTo(new BigDecimal("1e-15")) > 0) {
                x0 = x1;
                // 牛顿迭代公式：x(n+1) = (x(n) + value/x(n))/2
                x1 = x0.add(value.divide(x0, mathContext)).divide(new BigDecimal("2"), mathContext);
            }
            return x1;
        }


        // ------------------------------ 测试示例 ------------------------------





}