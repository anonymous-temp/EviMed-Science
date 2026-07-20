package com.sentum.pojo.dto;

import lombok.Data;

@Data
public class TrChoosexDto {
    /**
     * 药品id
     */
    private String drugId;
    /**
     * 临床需求
     */
    private String clinicalDemandOption;
    /**
     * 包装规格
     */
    private String packagingSpecificationOption;

    /**
     * 采用最大包装选项
     */
    private String largePackageAdoptionOption;

    /**
     * 单次用药选项
     */
    private String singleDoseOption;

    /**
     * 市场独特性
     */
    private String marketUniquenessOption;

    /**
     * 日均治疗费用
     */
    private String economicOption;

    private String priceId;
}
