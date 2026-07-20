package com.sentum.evidencecomprehensive.pojo.info;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

/**
 * 疾病数据接收类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("药品数据接收类")
public class Drug {
    @ApiModelProperty("用户输入条件")
    private String word;
    @ApiModelProperty("用户输入条件的中文")
    private String zhWord;
    @ApiModelProperty("用户输入条件的英文")
    private String enWord;
    @ApiModelProperty("中文同义词")
    private List<WordStatus> zhSynonym = new ArrayList<>();
    @ApiModelProperty("英文同义词")
    private List<WordStatus> enSynonym = new ArrayList<>();
    @ApiModelProperty("其他类型同义词")
    private List<WordStatus> otherSynonym = new ArrayList<>();
    @ApiModelProperty("别名")
    private List<String> drugNameAlias;
    @ApiModelProperty("药品名称")
    private String name = "";
    @ApiModelProperty("同义词拓展")
    private String expandSynonym;
    @ApiModelProperty("剂型")
    private String dosageForm = "";
    @ApiModelProperty("商品名")
    private String commodityName = "";
    @ApiModelProperty("当前节点的数据关系，用户输入条件1，与2，非3")
    private Integer status;
    
    private List<String> commodityNames;
    private List<String> zhDrugNames;
    private List<String> enDrugNames;
}
