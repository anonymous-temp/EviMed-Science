package com.sentum.pojo.dto;


import com.sentum.pojo.vo.GuidelinesVo;
import lombok.Data;

import java.util.List;

@Data
public class TraditionalInfoDto {

    /**
     * 不良反应
     */
    private String   adverseReaction;

    /**
     * 儿童用药
     */
    private String   childrenMedicine;

    /**
     * 老人用药
     */
    private String   pregnantWomen;

    /**
     * 老年用药
     */
    private String   geriatricMedicine;

    /**
     * 肝功能异常者用药
     */
    private String   doseAdjustmentPatientsWithLiverDysfunction;

    /**
     * 肾功能异常者用药
     */
    private String   doseAdjustmentPatientsWithRenalInsufficiency;

    /**
     * 药理作用
     */
    private String   pharmacology;

    /**
     * 贮存
     */
    private String   storage;

    /**
     * 有效期
     */
    private String   indate;

    /**
     * 用药ications
     */
    private String   indications;

    /**
     *
     */
    private String   ingredient;


    /**
     * 专利
     */
    private String   patent;

    /**
     * 指纹图谱
     */
    private String   fingerprint;


    /**
     * 企业相关
     */
    private String   manufacturers;


    /**
     * 古典名方
     */
    private String classic;

    /**
     * 指导
     */
    private List<GuidelinesVo> guide;

    /**
     * 文献
     */
    private List<GuidelinesVo> literature;

    /**
     * 有效性再评价
     */
    private String   validity;

    /**
     * 成分检查
     */
    private String   content;
    /**
     *安全性
     */
    private String   safety;

    private String   economyradion;

    private String drugName;


    private String drugChoice;

    private String description;

    private String contraindications;

    /**
     * 保密
     */
    private String   secret ;

    @Override
    public String toString() {
        return "TraditionalInfoDto{" +
                "adverseReaction='" + adverseReaction + '\'' +
                ", childrenMedicine='" + childrenMedicine + '\'' +
                ", pregnantWomen='" + pregnantWomen + '\'' +
                ", geriatricMedicine='" + geriatricMedicine + '\'' +
                ", doseAdjustmentPatientsWithLiverDysfunction='" + doseAdjustmentPatientsWithLiverDysfunction + '\'' +
                ", doseAdjustmentPatientsWithRenalInsufficiency='" + doseAdjustmentPatientsWithRenalInsufficiency + '\'' +
                ", pharmacology='" + pharmacology + '\'' +
                ", storage='" + storage + '\'' +
                ", indate='" + indate + '\'' +
                ", indications='" + indications + '\'' +
                ", ingredient='" + ingredient + '\'' +
                ", patent='" + patent + '\'' +
                ", fingerprint='" + fingerprint + '\'' +
                ", manufacturers='" + manufacturers + '\'' +
                ", classic='" + classic + '\'' +
                ", guide=" + guide +
                ", literature=" + literature +
                ", validity='" + validity + '\'' +
                ", content='" + content + '\'' +
                ", safety='" + safety + '\'' +
                ", economyradion='" + economyradion + '\'' +
                ", drugName='" + drugName + '\'' +
                ", drugChoice='" + drugChoice + '\'' +
                ", description='" + description + '\'' +
                ", contraindications='" + contraindications + '\'' +
                ", secret='" + secret + '\'' +
                '}';
    }

//    private String   ;


}
