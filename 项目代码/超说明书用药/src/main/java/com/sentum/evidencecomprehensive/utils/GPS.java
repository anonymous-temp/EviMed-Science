package com.sentum.evidencecomprehensive.utils;

import java.util.Random;

public class GPS {

    private static final Random random = new Random();

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

    public static void main(String[] args) {
        int a = 5, b = 10, c = 3, d = 20;
        double gpsEstimate = GPS(a, b, c, d);
        System.out.println("GPS Estimate: " + gpsEstimate);
    }
}
