package com.sentum.drugsafe.pojo;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.mongodb.core.mapping.Field;

import java.util.List;
import java.util.Map;

/**
 * 药物警戒IO模板对应数据的实体类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class DrugAlert {
    /**
     * id
     */
    private String id;

    /**
     * dataTotal
     */
    @Field("data_total")
    private String dataTotal;

    /**
     * ptNum
     */
    @Field("pt_num")
    private Integer ptNum;

    /**
     * database 数据库：fda,vigi
     */
    private String database;
    /**
     * drugname 药名
     */
    @Field("drugname")
    private List<String> drugName;
    /**
     * 药品成分
     */
    @Field("prod_ai")
    private List<String> prodAi;
    /**
     * 报告总数
     */
    @Field("total_num")
    private Integer totalNum;
    /**
     * 单药例数
     */
    @Field("single_num")
    private Integer singleNum;
    /**
     *联用药例数（暂不用）
     */
    @Field("dul_drug")
    private Integer dulDrug;
    /**
     * 逐年上报情况
     */
    @Field("year_list")
    private List<List<String>> yearList;
    /**
     * 信号合计值
     */
    @Field("signal_num")
    private Integer signalNum;
    /**
     *  性别组别信息
     */
    @Field("sex_m_f")
    private List<List<String>> sexMf;
    /**
     * 性别P值信息
     */
    @Field("sex_m_f_group")
    private List<List<String>> sexMfGroup;
    /**
     * 年龄组别信息
     */
    @Field("age_list")
    private List<List<String>> ageList;
    /**
     * 年龄组别信息
     */
    @Field("wt_list")
    private List<List<String>> wtList;
    /**
     * 年龄P值信息
     */
    @Field("age_group")
    private List<List<String>> ageGroup;
    /**
     * 国家/地区（合计）组别信息
     */
    @Field("reporter_country_list")
    private List<List<String>> reporterCountryList;

    @Field("reportType")
    private List<List<String>> reportType;
    /**
     * 国家/地区（合计）P值信息
     */
    @Field("reporter_country_group")
    private List<List<String>> reporterCountryGroup;
    /**
     * 职业信息
     */
    @Field("occp_cod")
    private List<List<String>> occpCod;
    /**
     *  严重不良反应结果
     */
    @Field("outc_cod_list")
    private List<List<String>> outCCodList;

    /**
     * 严重不良反应和非严重不良反应数量
     */
    @Field("outc_cod_count")
    private Map<String, Integer> outCCodCount;
    /**
     * 剂型组别信息
     */
    @Field("dose_form_list")
    private List<List<String>> doseFormList;
    /**
     * 剂型P值信息
     */
    @Field("dose_form_group")
    private List<List<String>> doseFormGroup;
    /**
     * 给药途径组别信息
     */
    @Field("route_list")
    private List<List<String>> routeList;
    /**
     * 给药途径P值信息
     */
    @Field("route_group")
    private List<List<String>> routeGroup;
    /**
     * 给药剂量组别信息
     */
    @Field("dose_amt_list")
    private List<List<String>> doseAmtList;
    /**
     * 给药剂量P值信息
     */
    @Field("dose_amt_group")
    private List<List<String>> doseAmtGroup;
    /**
     * 给药时间组别信息
     */
    @Field("dur_list")
    private List<List<String>> durList;
    /**
     * 给药时间P值信息
     */
    @Field("dur_group")
    private List<List<String>> durGroup;
    /**
     * 用药适应征分析
     */
    @Field("indi_pt_list")
    @JsonProperty("indi_pt_list")
    private List<List<String>> indiPtList;
    /**
     * 给药方案组别信息
     */
    @Field("drug_num_list")
    private List<List<String>> drugNumList;
    /**
     * 给药方案P值信息
     */
    @Field("drug_num_group")
    private List<List<String>> drugNumGroup;
    /**
     * 不良反应发生时间组别信息
     */
    @Field("cut_dt_list")
    private List<List<String>> cutDtList;
    /**
     * 不良反应发生时间P值信息
     */
    @Field("cut_dt_group")
    private List<List<String>> cutDtGroup;
    /**
     * pt 不良反应
     */
    private String pt;
    /**
     *  不良反应分布
     */
    @Field("pt_list")
    private List<List<String>> ptList;
    /**
     *  不良反应分布饼图
     */
    @Field("pt_list_group")
    private List<List<String>> ptListGroup;
    /**
     * 停药或减药后反应是否减轻或消失
     */
    @Field("dechal")
    private List<List<String>> dechal;
    /**
     * 重新使用药物反应是否再次出现
     */
    @Field("rechal")
    private List<List<String>> rechal;
    /**
     * 器官前五
     */
    @Field("organ_list")
    private List<String> organList;
    /**
     *  信号检测表
     */
    @Field("signal_dict")
    private Map<String,List<List<String>>> signalDict;


    /**
     *  信号检测表
     */
    @Field("signal_dict2")
    private Map<String,List<List<String>>> signalDict2;


    /**
     *  信号检测表
     */
    @Field("signal_dict3")
    private Map<String,List<List<String>>> signalDict3;

    /**
     *  信号检测表
     */
    @Field("signal_dict4")
    private Map<String,List<List<String>>> signalDict4;
    /**
     * 处置
     */
    @Field("disposeOf")
    private List<List<String>> disposeOf;

    /**
     *  药物-ADEs 组合的时间扫描图谱
     */
    @Field("time_atlas")
    private Map<String,List<List<String>>> timeAtlas;
    @Field("titleCount")
    private List<String> titleCount;
    @Field("adeTotle")
    private String adeTotle;


}
