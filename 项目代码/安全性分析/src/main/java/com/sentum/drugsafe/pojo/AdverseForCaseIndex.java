package com.sentum.drugsafe.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.apache.commons.lang3.StringUtils;
import org.springframework.data.annotation.Id;
import org.springframework.data.elasticsearch.annotations.Document;
import org.springframework.data.elasticsearch.annotations.Field;
import org.springframework.data.elasticsearch.annotations.FieldType;

import java.util.List;

/**
 * 不良反应es索引
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@Document(indexName = "adverse_case_index_1102", shards = 8)
public class AdverseForCaseIndex {
    @Id
    private String id;
    /**
     * 药品名称
     */
    private String drugName;
    /**
     * 药品成分名称
     */
    private String prodAi;
    /**
     * 不良反应列表
     */
    private List<String> ptList;
    /**
     * 不良反应列表的总数
     */
    @Field(type = FieldType.Long)
    private Long ptListNum;
    /**
     * 药品在报告中的作用，PS、SS、C、I四种情况
     */
    private String roleCod;
    /**
     * 年龄，分别有“未知”“≥65岁”“18＜年龄＜65”“≤18岁”四种情况
     */
    @Field(type = FieldType.Keyword)
    private String age;
    /**
     * 性别，"M""F""UNK"分别对应“男”“女”“未知”三种情况
     */
    @Field(type = FieldType.Keyword)
    private String sex;
    /**
     * 体重分布，分别有“未知”“>100kg”“50~100kg”“<50kg”四种情况
     */
    @Field(type = FieldType.Keyword)
    private String weight;
    /**
     * 上报地区分布，分别有"亚洲"、"欧洲"、"大洋洲"、"南美洲"、"北美洲"、"非洲"、"南极洲"、"未知"八种情况
     */
    @Field(type = FieldType.Keyword)
    private String reporterCountry;
    /**
     * 上报者职业分布， “MD”“PH”“OT”“LW”“UNK”分别对应"医生"、"药剂师"、"其他健康专家"、"律师"、"消费者"、"未知"六种情况
     */
    @Field(type = FieldType.Keyword)
    private String occupationalCod;
    /**
     * 严重不良反应结局，DE、LT、HO、DS、CA、RI、OT七种情况
     */
    @Field(type = FieldType.Keyword)
    private List<String> outcomeCod;
    /**
     * 严重不良反应结局的总数
     */
    @Field(type = FieldType.Long)
    private Long outcomeCodNum;
    /**
     * 年份
     */
    @Field(type = FieldType.Integer)
    private Integer year;
    /**
     * 时间 = 年份 + 月份
     */
    @Field(type = FieldType.Integer)
    private Integer time;
    /**
     * 重新使用药物反应是否再次出现，分别有"去激发阳性（减轻、消失）"、"去激发阴性（未消失或减轻）"、"不适用"、"未知"四种情况
     */
    @Field(type = FieldType.Keyword)
    private String dechal;
    /**
     * 停药或减药后反应是否减轻或消失，分别有"再激发阳性（出现）"、"再激发阴性（未出现）"、"不适用"、"未知"四种情况
     */
    @Field(type = FieldType.Keyword)
    private String rechal;
    /**
     * 治疗持续时间分布，无固定值，eg：1Days
     */
    @Field(type = FieldType.Keyword)
    private String dur;
    /**
     * 不良反应发生时间分布，无固定值，eg：31Days
     */
    @Field(type = FieldType.Keyword)
    private String reactionOfTime;

    @Field(type = FieldType.Keyword)
    private String dur2;
    /**
     * 不良反应发生时间分布，无固定值，eg：31Days
     */
    @Field(type = FieldType.Keyword)
    private String reactionOfTime2;
    /**
     * 是否是单药 true/false
     */
    @Field(type = FieldType.Boolean)
    private Boolean singleDrug;
    /**
     * 给药途径分布，无固定值
     */
    @Field(type = FieldType.Keyword)
    private String route;
    /**
     * 剂量分布，无固定值
     */
    @Field(type = FieldType.Keyword)
    private String doseAmtCombine;
    /**
     * 剂型分布，无固定值
     */
    @Field(type = FieldType.Keyword)
    private String doseForm;
    /**
     * 适应症，无固定值
     */
    private String indicationPt;
    /**
     * 同一份报告此id相同
     */
    @Field(type = FieldType.Keyword)
    private String oriDbId;
    @Field(type = FieldType.Integer)
    private Integer date;

    private Long prId;

    private Long caseId;


    public void setRechal(String rechal){
        if (StringUtils.isEmpty(rechal)){
            this.rechal =  "未知";
        }else
        if (rechal.equals("Y")){
            this.rechal =  "去激发阳性（减轻、消失）";
        }else
        if (rechal.equals("N")){
            this.rechal =  "去激发阴性（未消失或减轻）";
        }else
        if (rechal.equals("D")){
            this.rechal =  "不适用";
        }else{
            this.rechal =  "未知";
        }

    }


    public void setDechal(String dechal){
        if (StringUtils.isEmpty(dechal)){
            this.dechal =  "未知";
        }else
        if (dechal.equals("Y")){
            this.dechal =  "去激发阳性（减轻、消失）";
        }else
        if (dechal.equals("N")){
            this.dechal =  "去激发阴性（未消失或减轻）";
        }else
        if (dechal.equals("D")){
            this.dechal =  "不适用";
        }else {
            this.dechal =  "未知";
        }


    }
}
