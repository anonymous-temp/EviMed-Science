package com.sentum.evidencecomprehensive.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class SignalBean {
    private String pt;
    private Long a;
    private Long b;
    private Long c;
    private Long d;
    private Double ror;
    private Double ic;
    private Double gps;
    private Long num;
    private String zh;
    private String soc;
    private String rorLift;
    private String rorRight;
    private String icLift;
    private String icRight;


    public SignalBean(String pt,Long a,Long b,Long num) {
        this.pt = pt;
        this.a = a;
        this.b = b;
        this.num = num;
    }

    @Override
    public String toString() {
        return "SignalBean{" +
                "pt='" + pt + '\'' +
                ", a=" + a +
                ", b=" + b +
                ", c=" + c +
                ", d=" + d +
                '}';
    }
}
