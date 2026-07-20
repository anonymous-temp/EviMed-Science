package com.sentum.pojo.vo;

import cn.hutool.core.collection.CollUtil;
import com.alibaba.fastjson.JSONObject;
import com.sentum.pojo.DrugContent;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

import java.util.List;

@Data
@AllArgsConstructor
@NoArgsConstructor
@Document("instructions_mini")
public class DrugInstMini {

    private String id;

    /**
     * 注册账号
     */
    private String approveCode;

    @Field("commonName")
    private Object commonName;
    /**
     *
     */
    @Field("innName")
    private Object innName;

    /**
     * 成分
     */
    private List<DrugContent> component;

    /**
     * 规格
     */
    private List<DrugContent> form;

    /**
     * 适应症
     */
    private List<DrugContent> indication;

    /**
     * 用法用量
     */
    private List<DrugContent> dosage;

    /**
     * 孕妇
     */
    private List<DrugContent> useInPregLact;

    /**
     * 儿童
     */
    private List<DrugContent> useInChildren;

    /**
     * 老年用药
     */
    private List<DrugContent> useInElderly;

    /**
     * 适应症
     */
    private List<DrugContent> adverseReactions;

    /**
     * 药物警戒
     */
    private List<DrugContent> drugWarning;

    /**
     * 禁忌
     */
    private List<DrugContent> contraindications;

    /**
     * 注意事项
     */
    private List<DrugContent> precautions;

    /**
     * 药物配伍禁忌
     */
    private List<DrugContent> drugCompatibility;

    /**
     * 药物相互作用
     */
    private List<DrugContent> drugInteractions;

    /**
     * 药理作用
     */
    private List<DrugContent> mechanismAction;

    /**
     * 药代动力学
     */
    private List<DrugContent> pharmacokinetics;

    /**
     * 药物过量
     */
    private List<DrugContent> overdosage;

    /**
     * 药物分类
     */
    private List<DrugContent> cateName;

    /**
     * 性状
     */
    private List<DrugContent> description;

    /**
     * 贮藏
     */
    private List<DrugContent> storage;

    /**
     * 包装
     */
    private List<DrugContent> pack;

    /**
     * 有效期
     */
    private List<DrugContent> period;

    /**
     * 执行标准
     */
    private List<DrugContent> standard;

    /**
     * 上市许可持有人
     */
    private Object marketingAuthorisationHolder;

    /**
     * 生产企业
     */
    private Object companyName;

    /**
     * 患者手册
     */
    private List<DrugContent> patientEducation;

    /**
     * 临床试验
     */
    private List<DrugContent> clinicalTrial;

    /**
     * 化学成分
     */
    private List<DrugContent> chemical;

    /**
     * 毒理研究
     */
    private List<DrugContent> poison;

    /**
     * 用药须知
     */
    private List<DrugContent> cautions;

    private String pdf;

    private  List<DrugContent> effectsAndIndications;

    public String getCommonName() {
        if (commonName instanceof List) {
            List<?> list = (List<?>) commonName;
            if (!list.isEmpty() ) {
                JSONObject firstElement = (JSONObject) list.get(0);
                return firstElement.getString("concent");
            }
        } else if (commonName instanceof String) {
            return (String) commonName;
        }
        return null;
    }

    public List<DrugContent> getIndication() {
        if (CollUtil.isNotEmpty(indication)){
            return indication;
        }
        return effectsAndIndications;
    }







}
