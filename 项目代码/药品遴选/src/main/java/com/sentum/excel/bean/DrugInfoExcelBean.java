package com.sentum.excel.bean;

import com.alibaba.excel.annotation.ExcelProperty;
import lombok.Data;
import org.springframework.data.annotation.Id;

import java.io.Serializable;
import java.util.List;

/**
 * @Description:
 */
@Data
public class DrugInfoExcelBean implements Serializable {
    
    @ExcelProperty("产品名称")
    private String drugName; 
    
    @ExcelProperty("剂型")
    private String dosageForm;
    
    @ExcelProperty("厂家")
    private String manufacturer;

    @ExcelProperty("注册证号")
    private String register;
    
    @ExcelProperty("规格")
    private String specifications;
    
    @ExcelProperty("商品名-中文")
    private String commodityNameZh;
    
    @ExcelProperty("商品名-英文")
    private String commodityNameEn;

    @ExcelProperty("一级中文")
    private String oneNameZh;

    @ExcelProperty("一级英文")
    private String oneNameEn;

    @ExcelProperty("二级中文")
    private String twoNameZh;
    
    @ExcelProperty("二级英文")
    private String twoNameEn;
    
    @ExcelProperty("三级中文")
    private String threeNameZh;
    
    @ExcelProperty("三级英文")
    private String threeNameEn;
    
    @ExcelProperty("四级中文")
    private String fourNameZh;
    
    @ExcelProperty("四级英文")
    private String fourNameEn;
    
    @ExcelProperty("五级编码")
    private String fiveCoding;
    
    @ExcelProperty("五级英文")
    private String drugEn;

    @ExcelProperty("五级英文同义词")
    private String drugSynonymEn;
    
    @ExcelProperty("五级中文")
    private String drugZh;
    
    @ExcelProperty("五级中文同义词")
    private String drugSynonymZh;
    
    @ExcelProperty("甲乙类")
    private String medicalInsurance;
    
    @ExcelProperty("是否有支付限制")
    private String paymentScope;
    
    @ExcelProperty("是否基药")
    private String essentialMedicines;
    
    @ExcelProperty("是否有△要求")
    private String essentialType;
    
    @ExcelProperty("适应症原文")
    private String indication;

    @ExcelProperty("适应症-新")
    private String indicationZh;

//    @ExcelProperty("适应症_英文")
//    private String indicationEn;

//    @ExcelProperty("适应症_同义词")
//    private String indicationSynonym;
    
    @ExcelProperty("是否需要皮试")
    private String skinTest;
    
    @ExcelProperty("是否集采药品")
    private String drugCollection;
    
    @ExcelProperty("药理作用")
    private String pharmacology;
    
    @ExcelProperty("药代动力学")
    private String pharmacokinetics;
    
    @ExcelProperty("用法用量")
    private String usageAndDosage;
    
    @ExcelProperty("贮藏")
    private String storage;
    
    @ExcelProperty("有效期")
    private String indate;
    
    @ExcelProperty("功能主治/适应症")
    private String indications;
    
    @ExcelProperty("不良反应")
    private String adverseReaction;
    
    @ExcelProperty("孕妇及哺乳期妇女用药")
    private String pregnantWomen;
    
    @ExcelProperty("儿童用药")
    private String childrenMedicine;
    
    @ExcelProperty("老年用药")
    private String geriatricMedicine;
    
    @ExcelProperty("药物相互作用")
    private String drugInteraction;
    
    @ExcelProperty("是否原研药品")
    private String originalDrug;
    
    @ExcelProperty("是否仿制药参比药品")
    private String referenceDrug;
    
    @ExcelProperty("是否一致性评价药品")
    private String consistencyDrug;
    
    @ExcelProperty("成分")
    private String ingredient;

    @ExcelProperty("注意事项")
    private String notes;

    @ExcelProperty("禁忌")
    private String taboo;

    @ExcelProperty("单位")
    private String unit;

    @ExcelProperty("单位价格")
    private String unitPrice;

    @ExcelProperty("价格")
    private String price;

    @ExcelProperty("转换比")
    private String ratio;

    @ExcelProperty("集采药品中标价格（元）")
    private String outbidPrice;

    @ExcelProperty("规格-说明书")
    private String specificationsIns;

    @ExcelProperty("包装")
    private String pack;

    @ExcelProperty("说明书来源")
    private String insSource;

    @ExcelProperty("单方制剂/复方制剂")
    private String drugType;
}
