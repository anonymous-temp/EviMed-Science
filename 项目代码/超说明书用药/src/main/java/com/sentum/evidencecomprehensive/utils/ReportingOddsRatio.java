package com.sentum.evidencecomprehensive.utils;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;

public class ReportingOddsRatio {

    /**
     * 计算2x2列联表的报告几率比（ROR）。可选地，计算ROR的置信区间下限。
     *
     * @param a 药物组事件发生案例的数量。
     * @param b 药物组事件未发生案例的数量。
     * @param c 非药物组事件发生案例的数量。
     * @param d 非药物组事件未发生案例的数量。
     * @return ROR或ROR置信区间下限。
     */
    public static BigDecimal calculateROR(BigDecimal a, BigDecimal b, BigDecimal c, BigDecimal d) {
        // 根据公式 ROR = ad / bc 进行计算
        BigDecimal numerator = a.multiply(d);
        BigDecimal denominator = b.multiply(c);
        return numerator.divide(denominator, MathContext.DECIMAL128);
    }

    //计算置信区间


    // 计算 ROR 的 95% 置信区间
    public static BigDecimal[] calculate95CI(BigDecimal a, BigDecimal b, BigDecimal c, BigDecimal d,  BigDecimal ror) {
        // 计算 ROR

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



    private static void validateNonNegative(long value, String paramName) {
        if (value < 0) {
            throw new IllegalArgumentException(String.format("参数%s不可为负数：%d", paramName, value));
        }
    }

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

}
