package com.sentum.evidencecomprehensive.utils;

import org.apache.commons.math3.special.Gamma;

public class BCPNNScoreCalculator {

    private static final double LOG_2 = Math.log(2);

    public static double[] calculateBCPNN(double[] a, double[] b, double[] c, double[] d) {
        double[] icValues = new double[a.length];
        for (int i = 0; i < a.length; i++) {
            icValues[i] = calculateIC(a[i], b[i], c[i], d[i]);
        }
        return icValues;
    }

    public static double calculateIC(double a, double b, double c, double d) {
        double n1_ = a + c;
        double n_1 = a + b;
        double n = a + b + c + d;
        double p1 = 1 + n1_;
        double p2 = 1 + n - n1_;
        double q1 = 1 + n_1;
        double q2 = 1 + n - n_1;
        double r1 = a + 1;
        double r2b = n - a - 1 + Math.pow((2 + n), 2) / (q1 * p1);

        double ic = (digamma(r1) - digamma(r1 + r2b) - 
                     (digamma(p1) - digamma(p1 + p2) + digamma(q1) - 
                      digamma(q1 + q2))) / LOG_2;
        
        return ic;
    }

    private static double digamma(double x) {
        return Gamma.digamma(x);
    }

    public static void main(String[] args) {
        double[] a = {10, 20, 30};
        double[] b = {15, 25, 35};
        double[] c = {5, 10, 15};
        double[] d = {20, 30, 40};

        double[] icValues = calculateBCPNN(a, b, c, d);
        for (double ic : icValues) {
            System.out.println(ic);
        }
    }
}
