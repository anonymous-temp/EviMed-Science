package com.sentum.pojo.vo;

import lombok.Data;

@Data
public class BulletinBoardVo {
    /**
     * 安全性
     */
    private Object  security;

    /**
     * 有效性
     */
    private Object  effectiveness;

    /**
     * 经济性
     */
    private Object  economicViability;

    /**
     * 药学特性
     */
    private Object  pharmacy;

    /**
     * 适用性
     */
    private Object  applicability;

    /**
     * 政策准入
     */
    private Object  policy;

    /**
     * 总分
     */
    private String totalScore;

    /**
     * 搜索id
     */
    private String reportId;















}
