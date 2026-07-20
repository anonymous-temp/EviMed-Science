package com.sentum.evidencecomprehensive.pojo.dto;

import com.sentum.evidencecomprehensive.pojo.info.WordStatus;
import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

/**
 * 同义词反馈的dto类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel(value = "SynonymFeedbackDto", description = "同义词反馈的dto类")
public class SynonymFeedbackDto {
    @ApiModelProperty("用户输入条件")
    private String word;
    @ApiModelProperty("中文同义词")
    private List<WordStatus> zhSynonym = new ArrayList<>();
    @ApiModelProperty("英文同义词")
    private List<WordStatus> enSynonym = new ArrayList<>();
}
