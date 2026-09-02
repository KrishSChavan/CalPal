// const input = document.getElementById('input');
// const submit_text = document.getElementById('submit-text');


// const fileInput = document.getElementById("imageInput");
// const submit_file = document.getElementById("submit-file");

// const result_elem = document.getElementById('response');


// submit_text.addEventListener('click', () => {
//   if (input.value.trim() == "") return;

//   getAskData(input.value.trim());
//   getHelloData();
// });





submit_file.addEventListener('click', () => {
  if (!fileInput.files.length) {
    result_elem.innerText = "Please select an image.";
    return;
  }

  const formData = new FormData();
  formData.append("image", fileInput.files[0]);

  getImageData(formData)
});



function getImageData(formData) {
  axios.post("/api/analyze-image", formData)
    .then(res => {
      result_elem.innerText = res.data.reply;
    })
    .catch(err => {
      console.error(err);
      result_elem.innerText = "Error analyzing image.";
    });
}




function getAskData(userMessage) {
  axios.post("/api/ask", { message: userMessage })
    .then(response => {
      result_elem.innerText = response.data.reply;
    })
    .catch(error => {
      console.error("Error:", error);
      result_elem.innerText = "Something went wrong.";
    });
}


function getHelloData() {
  axios.get('/api/hello')
    .then(response => {
      const data = response.data;
      result_elem.innerText = JSON.stringify(data, null, 2);
    })
    .catch(error => {
      console.error("Error fetching data:", error);
      result_elem.innerText = "Error fetching data.";
    });
}