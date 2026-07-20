package com.sentum.drugsafe.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import io.swagger.annotations.ApiModel;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;

/**
 * 药品安全性分析请求实体
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel(value = "SafeInfoDto", description = "药品安全性分析dto类")
public class SafeInfoDto implements Serializable {
    /**
     * 用户id
     */
    @JsonProperty("UserId")
    private String userId;
    /**
     * 检索id
     */
    @JsonProperty("SearchID")
    private String searchID;
    /**
     * 用户指定的药品名称列表，1、如果为复数个，用"||"分割
     * 2、单个药品与同义词之间用"&&"分割
     * 3、如果没有则传空值""
     */
    @JsonProperty("UserDrugNames")
    private String userDrugNames;
    /**
     * true为精准查询药名，false为模糊查询药名
     */
    @JsonProperty("DrugNamesAccurate")
    private String drugNamesAccurate;
    /**
     * 用户指定的不良反应名称列表，
     * 1、如果为复数个，用"||"分割
     * 2、如果没有则传空值""
     */
    @JsonProperty("UserADRS")
    private String userADRS;
    /**
     * true为精准查询不良反应名称，false为模糊查询
     */
    @JsonProperty("ADRSAccurate")
    private String aDRSAccurate;
    /**
     * true为初始查询，不看下面所有选择（外面一框式检索时为true，后续再次检索为false），false为后续再次查询需要查看下面所有选择
     */
    @JsonProperty("BasicSearch")
    private String basicSearch;
    /**
     * 形如“199606”的开始日期，不限为空值""
     */
    @JsonProperty("BeginDate")
    private String beginDate;
    /**
     * 形如“199606”的截止日期，不限为空值""
     */
    @JsonProperty("EndDate")
    private String endDate;
    /**
     * 用户指定的适应症名称列表，
     * 1、如果为复数个，用"||"分割
     * 2、如果没有则传空值""
     */
    @JsonProperty("UserIndications")
    private String  userIndications;
    /**
     * 不限为-1,除“不限”选择外，从左至右按照选择为1不选择为0的规则拼接为1001这种的二进制并转化为十进制传输，比如用户只选择了PS跟SS则传值为12（二进制1100）
     */
    @JsonProperty("RoleCode")
    private String roleCode;
    /**
     * 严重不良反应结局
     */
    @JsonProperty("OutcCode")
    private String outcCode;
    /**
     * 报告者职业
     */
    @JsonProperty("OccpCode")
    private String occpCode;
    /**
     * 患者性别
     */
    @JsonProperty("Sex")
    private String sex;
    /**
     * 患者年龄
     */
    @JsonProperty("Age")
    private String age;

    @JsonProperty("isShowUnknown")
    private String isShowUnknown;

}
