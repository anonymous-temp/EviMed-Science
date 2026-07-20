package com.sentum.evidencecomprehensive.domain.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;

/**
 * Description: 首页弹框 用户输入初始数据
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class DrugConditionDTO implements Serializable {
    
    /**
     * 用户输入检索词
     */
    private String name;
    
    /**
     * 产品名称 这个是药品的产品名称 和输入词会有所不同
     */
    private String drugName;
    
    /**
     * 商品名
     */
    private String commodityName;
    
    /**
     * 剂型
     */
    private String dosage;
    
    /**
     * 厂家
     */
    private String manufacturer;
    
    /**
     * 规格
     */
    private String specification;
}
