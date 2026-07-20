package com.sentum.evidencecomprehensive.domain.dto;

import com.fasterxml.jackson.annotation.JsonIgnore;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 疾病数据接收类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("疾病数据接收类")
public class Disease {
    @ApiModelProperty("用户勾选的疾病类型，1-疾病名称；2-患病人群")
    private Integer type;
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
    @ApiModelProperty("同义词拓展")
    private String expandSynonym;
    @ApiModelProperty("当前节点的数据关系，用户输入条件1，与2，非3，或4")
    private Integer status;
    @JsonIgnore
    private List<String> expandedWords;
    @JsonIgnore
    private List<String> deconsWords;
    @JsonIgnore
    private Map<String, Set<String>> synonymMap;
}
