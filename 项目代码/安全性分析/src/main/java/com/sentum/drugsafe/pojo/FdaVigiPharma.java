package com.sentum.drugsafe.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Field;

import java.util.List;
import java.util.Map;

/**
 * 不良反应数据对应实体类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class FdaVigiPharma {
    /**
     * id
     */
    private String id;
    /**
     * database 数据库：fda,vigi
     */
    private String database;
    /**
     * 该不良反应病例数
     */
    @Field("cases_num")
    private int casesNum;
    /**
     * drug_list 药物名列表
     */
    @Field("drug_list")
    private List<String> drugList;
    /**
     * adr 不良反应
     */
    private String adr;
    /**
     * 2.1 药物使用分布（both FEARS and VIGI），按cases_num降序排列，只留前十个
     */
    @Field("drug_use_distrib")
    private List<Map<String,String>> drugUseDistrib;
    /**
     *  2.2 典型不良反应信号在药物中的分布（both FEARS and VIGI）
     */
    @Field("adr_distrib")
    private List<String> adrDistrib;
    /**
     * 2.3 不良反应的适应症分布（only FEARS），按cases_num降序排列，只留前十个
     */
    @Field("indi_distrib")
    private List<Map<String,String>> indiDistrib;
    /**
     * 2.4 不良反应发生时间分布（only FEARS），按cases_num降序排列，只留前十个
     */
    @Field("time_distrib")
    private List<Map<String,String>> timeDistrib;
    /**
     * 2.5 伴生的其他不良反应分析（both FEARS and VIGI），按照 proportion 降序排列
     */
    @Field("associated_adrs")
    private List<Map<String,String>> associatedAdrs;
    /**
     * 2.6 不良反应严重性评价（only FEARS）
     */
    @Field("severity_distrib")
    private Map<String,String> severityDistrib;
}
